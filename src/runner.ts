/**
 * Running one simulation, running many, and cutting a failure down to size.
 *
 * Finding a bug is the easy half. A failure that arrives as a 4,000-step trace
 * is not much more actionable than "it's flaky" — so once a seed fails, the
 * shrinker replays it over and over, each time pushing one more decision back
 * toward its dullest value, keeping any variant that still fails the same way.
 * What survives is the smallest schedule that still breaks the code.
 */

import { Kernel } from "./kernel.js";
import { Rng, formatSeed, normalizeSeed } from "./prng.js";
import { formatFailure } from "./report.js";
import type { CheckOptions, Failure, RunResult, Sim, SimulateOptions } from "./types.js";

export type SimBody = (sim: Sim) => Promise<void> | void;

/** Run the body once under a fully controlled world. Never throws on failure. */
export async function simulate(body: SimBody, options: SimulateOptions = {}): Promise<RunResult> {
  return new Kernel(options).run(body);
}

export interface CheckReport {
  name: string;
  ok: boolean;
  /** How many seeds were explored. */
  runs: number;
  /** The failing run, already shrunk. Null when the property held. */
  failure: RunResult | null;
  /** Which run number failed, 1-based. */
  failedOnRun: number | null;
  /**
   * Scheduler steps before and after shrinking. Steps rather than decisions,
   * because steps are what a human reads in the timeline — a shrink that
   * halves the decision tape but leaves the timeline just as long has not
   * actually helped anyone.
   */
  shrank: { from: number; to: number } | null;
}

/** Thrown by `check` when a property does not hold, carrying the full report. */
export class UnflakeFailure extends Error {
  override readonly name = "UnflakeFailure";

  constructor(
    message: string,
    readonly report: CheckReport,
  ) {
    super(message);
  }
}

/**
 * Explore many seeds looking for one that breaks the property.
 *
 * Each seed is a different set of scheduling choices, so this is closer to
 * property-based testing over *interleavings* than to repeating a test: 200
 * runs is 200 genuinely different orderings, not 200 rolls of the same dice.
 */
export async function check(
  name: string,
  body: SimBody,
  options: CheckOptions = {},
): Promise<CheckReport> {
  const runs = Math.max(1, options.runs ?? 200);
  const baseSeed = normalizeSeed(options.seed ?? 1);
  const seedSource = new Rng(`unflake:seeds:${baseSeed}`);

  for (let i = 0; i < runs; i++) {
    // Run 1 uses the seed verbatim, so `{ seed }` from a report reproduces
    // immediately without having to replay the whole sweep.
    const seed = i === 0 ? baseSeed : seedSource.uint32();
    const result = await simulate(body, { ...options, seed, plan: [], planStrict: false });
    if (result.ok) continue;

    const shrinking = options.shrink !== false;
    const shrunk = shrinking ? await shrink(body, result, options) : result;
    const report: CheckReport = {
      name,
      ok: false,
      runs,
      failure: shrunk,
      failedOnRun: i + 1,
      // Null means "no shrinking was attempted", which is different from
      // "shrinking ran and found nothing to remove".
      shrank: shrinking ? { from: result.steps, to: shrunk.steps } : null,
    };
    const message = formatFailure(report);
    if (options.verbose !== false) console.error(message);
    throw new UnflakeFailure(message, report);
  }

  return { name, ok: true, runs, failure: null, failedOnRun: null, shrank: null };
}

/** Two failures count as "the same bug" when kind, invariant and text match. */
function sameFailure(a: Failure, b: Failure | null): boolean {
  if (!b) return false;
  return a.kind === b.kind && a.invariant === b.invariant && a.message === b.message;
}

/**
 * Prefer the run that is easier to read: fewer steps first, then fewer
 * non-default decisions, then a shorter plan. Step count is what a human
 * actually reads in the timeline, so it leads.
 */
function score(result: RunResult): [number, number, number] {
  const nonZero = result.plan.reduce((n, v) => n + (v === 0 ? 0 : 1), 0);
  return [result.steps, nonZero, result.plan.length];
}

function better(candidate: RunResult, incumbent: RunResult): boolean {
  const a = score(candidate);
  const b = score(incumbent);
  return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
}

async function shrink(
  body: SimBody,
  failing: RunResult,
  options: CheckOptions,
): Promise<RunResult> {
  const target = failing.failure;
  if (!target) return failing;
  const budget = options.shrinkAttempts ?? 500;
  let attempts = 0;

  const replay = async (plan: readonly number[]): Promise<RunResult | null> => {
    if (attempts++ >= budget) return null;
    const result = await simulate(body, {
      ...options,
      seed: failing.seed,
      plan,
      planStrict: true,
    });
    return result.ok || !sameFailure(target, result.failure) ? null : result;
  };

  // The recorded run drew its tail from the rng; re-running it in strict mode
  // is the first candidate. If that no longer reproduces, the failure depends
  // on decisions past the tape and there is nothing safe to shrink.
  let best = (await replay(failing.plan)) ?? null;
  if (!best) return failing;

  let improved = true;
  while (improved && attempts < budget) {
    improved = false;

    // Pass 1 — zero out blocks of decisions, halving the block size each
    // sweep. Blocks first because whole phases of a run are often irrelevant,
    // and removing them one index at a time would burn the budget.
    for (let width = Math.max(1, best.plan.length >> 1); width >= 1; width >>= 1) {
      for (let start = 0; start < best.plan.length && attempts < budget; start += width) {
        if (best.plan.slice(start, start + width).every((v) => v === 0)) continue;
        const candidate = best.plan.slice();
        for (let i = start; i < Math.min(start + width, candidate.length); i++) candidate[i] = 0;
        const result = await replay(candidate);
        if (result && better(result, best)) {
          best = result;
          improved = true;
        }
      }
    }

    // Pass 2 — halve the values that survived. Latency draws shrink toward
    // their minimum here, which is what collapses a timeline spread over
    // minutes into one spread over milliseconds.
    for (let i = 0; i < best.plan.length && attempts < budget; i++) {
      let value = best.plan[i] ?? 0;
      while (value > 0 && attempts < budget) {
        const next = value >> 1;
        const candidate = best.plan.slice();
        candidate[i] = next;
        const result = await replay(candidate);
        if (!result || !better(result, best)) break;
        best = result;
        improved = true;
        value = next;
      }
    }

    // Pass 3 — drop the tail. In strict mode everything past the plan is
    // already 0, so trailing zeros carry no information.
    let end = best.plan.length;
    while (end > 0 && best.plan[end - 1] === 0) end--;
    if (end < best.plan.length && attempts < budget) {
      const result = await replay(best.plan.slice(0, end));
      if (result) {
        best = result;
        improved = true;
      }
    }
  }

  return best;
}

export { formatSeed };
