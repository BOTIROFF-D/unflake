/**
 * Runs that go nowhere have to stop by themselves.
 *
 * Virtual time is free, which is the whole point — but it means a runaway
 * simulation looks perfectly healthy from the inside while burning real
 * minutes. If the test runner kills it first, the run never reaches its
 * cleanup, the patched globals stay patched, and every later test in that
 * process fails for a reason that has nothing to do with what it was testing.
 *
 * So the kernel watches a real clock too, and gives up on its own terms.
 */

import { describe, expect, it } from "vitest";
import { simulate } from "../src/runner.js";
import { yieldToHost, yieldViaMessageChannel } from "../src/globals.js";

describe("budgets", () => {
  it("stops a livelock on the step budget", async () => {
    const result = await simulate(
      async (sim) => {
        // A timer that reschedules itself forever: virtual time advances,
        // the test never finishes, nothing is deadlocked.
        const tick = () => {
          setTimeout(tick, 1);
        };
        tick();
        await sim.sleep(1_000_000_000);
      },
      { maxSteps: 500 },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("budget");
    expect(result.failure?.message).toContain("step budget");
  });

  it("stops a slow run on the wall-clock budget", async () => {
    const result = await simulate(
      async (sim) => {
        const tick = () => {
          setTimeout(tick, 1);
        };
        tick();
        await sim.sleep(1_000_000_000);
      },
      // Zero real milliseconds: the very first check trips it.
      { maxWallClockMs: 0, maxSteps: 10_000_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("budget");
    expect(result.failure?.message).toContain("wall-clock budget");
  });

  it("restores globals after a budget failure, so later runs still work", async () => {
    const before = globalThis.setTimeout;
    await simulate(
      async (sim) => {
        const tick = () => {
          setTimeout(tick, 1);
        };
        tick();
        await sim.sleep(1_000_000_000);
      },
      { maxWallClockMs: 0 },
    );
    expect(globalThis.setTimeout).toBe(before);

    const after = await simulate(async (sim) => {
      await sim.sleep(5);
    });
    expect(after.ok).toBe(true);
  });

  it("yields through a fast macrotask primitive", async () => {
    // This runs once per scheduler step, so its cost is the tool's cost.
    // Node floors setTimeout at 1ms; if the yield ever falls back to a timer
    // everything gets ~80x slower, which is what this pins.
    const iterations = 200;
    const started = performance.now();
    for (let i = 0; i < iterations; i++) await yieldToHost();
    const perYield = (performance.now() - started) / iterations;
    expect(perYield).toBeLessThan(0.5);
  });

  it("has a working MessagePort fallback for hosts without setImmediate", async () => {
    // In Node the setImmediate branch always wins, so this path would
    // otherwise ship untested and fail for the first person to run unflake
    // somewhere that lacks it.
    const iterations = 200;
    const started = performance.now();
    for (let i = 0; i < iterations; i++) {
      const yielded = yieldViaMessageChannel();
      expect(yielded).not.toBeNull();
      await yielded;
    }
    const perYield = (performance.now() - started) / iterations;
    expect(perYield).toBeLessThan(0.5);
  });
});
