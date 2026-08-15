/**
 * Systematic exploration — walking the whole space instead of sampling it.
 *
 * `check` draws random schedules. That finds bugs, but a clean result only
 * ever means "not found in 200 tries". `explore` enumerates the decision tree
 * instead: run, look at which choices the run actually made, and for every
 * choice that had an untaken alternative, queue the prefix that takes it.
 * Repeat until the queue is empty.
 *
 * When the queue empties before the schedule cap, every execution the model
 * can produce has been run. That is a different kind of statement from a
 * passing sample — within the model's bounds, it is a proof.
 *
 * The catch is the one every stateless model checker has: the tree grows
 * multiplicatively. There is no partial-order reduction here — unflake cannot
 * see which operations touch shared state, so it cannot know that two
 * orderings are equivalent and skip one. Wide latency ranges are the usual
 * way a space becomes unenumerable: `latency: [1, 25]` is a 25-way branch at
 * every single I/O. Keep ranges narrow for the tests you want to exhaust, and
 * use `check` for everything else.
 */

import { shrink } from "./runner.js";
import { simulate } from "./runner.js";
import { formatFailure } from "./report.js";
import type { CheckOptions, RunResult, Sim } from "./types.js";

export type SimBody = (sim: Sim) => Promise<void> | void;

export interface ExploreOptions extends Omit<CheckOptions, "runs"> {
  /**
   * Upper bound on schedules to run. Reaching it means the space was *not*
   * exhausted, and the report says so. Default 5,000.
   */
  maxSchedules?: number;
  /**
   * Called after each schedule completes. Useful for progress on a long
   * enumeration, and it is how the test suite verifies that no schedule is
   * ever run twice — a duplicate would inflate the count that the
   * exhaustiveness claim is stated in terms of.
   */
  onSchedule?: (result: RunResult, index: number) => void;
}

export interface ExploreReport {
  name: string;
  ok: boolean;
  /** How many distinct schedules were actually run. */
  schedules: number;
  /**
   * True only when the queue emptied on its own. When true and `ok` is also
   * true, no execution of this test can fail — not "none was found".
   */
  exhaustive: boolean;
  /** The failing schedule, already shrunk. Null when nothing failed. */
  failure: RunResult | null;
  /** Which schedule number failed, 1-based. */
  failedOnSchedule: number | null;
  shrank: { from: number; to: number } | null;
}

/** Thrown by `explore` when some schedule breaks the property. */
export class UnflakeExploreFailure extends Error {
  override readonly name = "UnflakeExploreFailure";

  constructor(
    message: string,
    readonly report: ExploreReport,
  ) {
    super(message);
  }
}

const DEFAULT_MAX_SCHEDULES = 5000;

export async function explore(
  name: string,
  body: SimBody,
  options: ExploreOptions = {},
): Promise<ExploreReport> {
  const maxSchedules = Math.max(1, options.maxSchedules ?? DEFAULT_MAX_SCHEDULES);

  // Breadth-first, so the first counterexample found is one that deviates
  // from the natural schedule as little as possible. Depth-first would dive
  // to the bottom of the tree and hand back a needlessly exotic one.
  const frontier: number[][] = [[]];
  const seen = new Set<string>();
  let schedules = 0;

  while (frontier.length > 0 && schedules < maxSchedules) {
    const plan = frontier.shift() as number[];
    const key = plan.join(",");
    // A run whose plan is longer than the decisions it actually makes can
    // land on a prefix another branch already covered. Rare, but cheap to
    // rule out, and a double-counted schedule would corrupt the totals that
    // the exhaustiveness claim rests on.
    if (seen.has(key)) continue;
    seen.add(key);

    const result = await simulate(body, { ...options, plan, planStrict: true });
    schedules++;
    options.onSchedule?.(result, schedules);

    if (!result.ok) {
      const shrinking = options.shrink !== false;
      const shrunk = shrinking ? await shrink(body, result, options) : result;
      const report: ExploreReport = {
        name,
        ok: false,
        schedules,
        exhaustive: false,
        failure: shrunk,
        failedOnSchedule: schedules,
        shrank: shrinking ? { from: result.steps, to: shrunk.steps } : null,
      };
      const message = formatFailure({
        name,
        runs: schedules,
        failure: shrunk,
        failedOnRun: schedules,
        shrank: report.shrank,
        unit: "schedule",
      });
      if (options.verbose !== false) console.error(message);
      throw new UnflakeExploreFailure(message, report);
    }

    // Two kinds of child, and both are needed for the tree to be covered
    // exactly once.
    //
    // First, this node's next sibling: the same prefix with its last forced
    // decision bumped by one. Siblings are produced one at a time, each by
    // the previous one, rather than all at once by the parent. Without this
    // a decision with three or more options only ever reaches its second —
    // and the enumeration would still report itself exhaustive, just with a
    // smaller number, which is the worst way to be wrong.
    if (plan.length > 0) {
      const i = plan.length - 1;
      const decision = result.decisions[i];
      if (decision && decision.value + 1 < decision.bound) {
        frontier.push([...result.plan.slice(0, i), decision.value + 1]);
      }
    }

    // Second, the first alternative at each index this plan did not fix.
    // Together with the sibling rule above, every node has exactly one
    // parent, which is what makes the schedule count mean something.
    for (let i = plan.length; i < result.decisions.length; i++) {
      const decision = result.decisions[i];
      if (!decision) continue;
      if (decision.value + 1 < decision.bound) {
        frontier.push([...result.plan.slice(0, i), decision.value + 1]);
      }
    }
  }

  return {
    name,
    ok: true,
    schedules,
    exhaustive: frontier.length === 0,
    failure: null,
    failedOnSchedule: null,
    shrank: null,
  };
}
