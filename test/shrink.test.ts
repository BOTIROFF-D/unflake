/**
 * Shrinking has to be sound before it is allowed to be clever.
 *
 * A shrinker that reports a smaller counterexample which does not actually
 * fail is worse than no shrinker at all: it sends someone to read a schedule
 * that never broke anything, and when they cannot see the bug in it they stop
 * trusting the tool. So the properties below are about honesty first —
 * whatever comes out of the shrinker must still reproduce, and must never be
 * bigger than what went in.
 */

import { describe, expect, it } from "vitest";
import { check, simulate, UnflakeFailure } from "../src/index.js";
import type { Sim } from "../src/index.js";

/**
 * Breaks only when a slow writer lands after a fast one. The failure is real
 * but needs a specific ordering, so there is genuinely something to shrink.
 */
async function racyWriter(sim: Sim): Promise<void> {
  let cell = 0;
  let peak = 0;
  sim.invariant("cell never decreases", () => {
    peak = Math.max(peak, cell);
    return cell >= peak;
  });
  await sim.parallel(4, async (i) => {
    await sim.sleep(i);
    const value = i + 1;
    await sim.io(`write-${i}`, { latency: [1, 40] });
    cell = value;
  });
}

async function failingRun(options: Parameters<typeof check>[2] = {}) {
  return check("cell never decreases", racyWriter, {
    runs: 300,
    verbose: false,
    ...options,
  }).catch((error: UnflakeFailure) => error.report);
}

describe("shrinking", () => {
  it("returns a counterexample that genuinely reproduces", async () => {
    const report = await failingRun();
    const shrunk = report.failure;
    expect(shrunk?.failure).toBeTruthy();

    // Replay exactly what the report told the user to run.
    const replay = await simulate(racyWriter, { plan: shrunk!.plan, planStrict: true });
    expect(replay.ok).toBe(false);
    expect(replay.failure?.kind).toBe(shrunk!.failure?.kind);
    expect(replay.failure?.message).toBe(shrunk!.failure?.message);
    expect(replay.steps).toBe(shrunk!.steps);
  });

  it("never returns something larger than the original failure", async () => {
    const report = await failingRun();
    expect(report.shrank).toBeTruthy();
    expect(report.shrank!.to).toBeLessThanOrEqual(report.shrank!.from);
  });

  it("leaves the run untouched when shrinking is off", async () => {
    const report = await failingRun({ shrink: false });
    expect(report.shrank).toBeNull();
    expect(report.failure?.failure).toBeTruthy();
  });

  it("respects the attempt budget", async () => {
    // One attempt is not enough to improve anything; the result must still be
    // a valid, reproducible counterexample rather than an error.
    const report = await failingRun({ shrinkAttempts: 1 });
    const shrunk = report.failure;
    expect(shrunk?.failure).toBeTruthy();
    const replay = await simulate(racyWriter, {
      seed: shrunk!.seed,
      plan: shrunk!.plan,
      planStrict: true,
    });
    expect(replay.ok).toBe(false);
  });

  it("reports success without a counterexample when the property holds", async () => {
    const report = await check(
      "a guarded cell never decreases",
      async (sim) => {
        let cell = 0;
        let peak = 0;
        sim.invariant("cell never decreases", () => {
          peak = Math.max(peak, cell);
          return cell >= peak;
        });
        await sim.parallel(4, async (i) => {
          await sim.sleep(i);
          const value = i + 1;
          await sim.io(`write-${i}`, { latency: [1, 40] });
          if (value > cell) cell = value;
        });
      },
      { runs: 300, verbose: false },
    );
    expect(report.ok).toBe(true);
    expect(report.failure).toBeNull();
    expect(report.runs).toBe(300);
  });
});
