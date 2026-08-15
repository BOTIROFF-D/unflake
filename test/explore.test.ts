/**
 * The exhaustiveness claim.
 *
 * `explore` says something much stronger than `check` does: not "no failure
 * was found" but "no failure exists". A claim like that has to be earned, and
 * the way to earn it is to check the enumeration against spaces whose size can
 * be worked out on paper — if the tool reports six schedules where combinatorics
 * says six, and never runs the same one twice, the count means what it says.
 *
 * The failure mode to guard against is the quiet one: an off-by-one in the
 * branching rule that skips a subtree would still report `exhaustive: true`,
 * just with a smaller number, and nobody would notice until the proof was
 * already being trusted.
 */

import { describe, expect, it } from "vitest";
import { explore, UnflakeExploreFailure } from "../src/explore.js";
import type { Sim } from "../src/index.js";

/** `n` tasks that all become ready at the same instant: n! orderings. */
const simultaneous = (n: number) => async (sim: Sim) => {
  const order: number[] = [];
  await sim.parallel(n, async (i) => {
    await sim.sleep(1);
    order.push(i);
  });
};

describe("systematic exploration", () => {
  it("enumerates exactly as many schedules as the combinatorics predict", async () => {
    // Every task wakes at the same virtual instant, so the whole space is the
    // set of orderings of that one batch: n! of them, and nothing else.
    for (const [tasks, expected] of [
      [2, 2],
      [3, 6],
      [4, 24],
    ] as const) {
      const report = await explore(`${tasks} simultaneous tasks`, simultaneous(tasks), {
        verbose: false,
      });
      expect(report.ok, `${tasks} tasks`).toBe(true);
      expect(report.exhaustive, `${tasks} tasks`).toBe(true);
      expect(report.schedules, `${tasks} tasks`).toBe(expected);
    }
  });

  it("never runs the same schedule twice", async () => {
    const plans: string[] = [];
    const report = await explore("distinctness", simultaneous(4), {
      verbose: false,
      onSchedule: (result) => plans.push(result.plan.join(",")),
    });
    expect(plans).toHaveLength(report.schedules);
    expect(new Set(plans).size).toBe(plans.length);
  });

  it("covers every ordering, not just the right number of them", async () => {
    // Counting is not the same as covering: a branching bug could produce 6
    // schedules that miss one permutation and repeat another shape. So check
    // the observable outcome — all 6 orders of 3 tasks must actually occur.
    const orders = new Set<string>();
    await explore(
      "coverage",
      async (sim) => {
        const seen: number[] = [];
        await sim.parallel(3, async (i) => {
          await sim.sleep(1);
          seen.push(i);
        });
        orders.add(seen.join(""));
      },
      { verbose: false },
    );
    expect([...orders].sort()).toEqual(["012", "021", "102", "120", "201", "210"]);
  });

  it("admits when it did not finish", async () => {
    const report = await explore("capped", simultaneous(6), {
      verbose: false,
      maxSchedules: 10,
    });
    expect(report.schedules).toBe(10);
    // 6! is 720. Ten schedules is not a proof of anything and must not claim
    // to be — this is the assertion that stops the tool from lying.
    expect(report.exhaustive).toBe(false);
  });

  it("proves a correct implementation cannot fail", async () => {
    // Narrow latencies keep the space enumerable: each io is a 2-way branch
    // rather than a 25-way one.
    const guarded = async (sim: Sim) => {
      let cached = 0;
      let peak = 0;
      sim.invariant("versions never go backwards", () => {
        peak = Math.max(peak, cached);
        return cached >= peak;
      });
      await sim.parallel(3, async (i) => {
        const snapshot = i + 1;
        await sim.io("fetch", { latency: [1, 2] });
        if (snapshot > cached) cached = snapshot;
      });
    };

    const report = await explore("guarded cache versions never go backwards", guarded, {
      verbose: false,
    });
    expect(report.ok).toBe(true);
    expect(report.exhaustive).toBe(true);
    expect(report.schedules).toBeGreaterThan(1);
  });

  it("finds the bug the guarded version does not have", async () => {
    const unguarded = async (sim: Sim) => {
      let cached = 0;
      let peak = 0;
      sim.invariant("versions never go backwards", () => {
        peak = Math.max(peak, cached);
        return cached >= peak;
      });
      await sim.parallel(3, async (i) => {
        const snapshot = i + 1;
        await sim.io("fetch", { latency: [1, 2] });
        cached = snapshot; // no comparison — a slow fetch overwrites a fast one
      });
    };

    const error = await explore("versions never go backwards", unguarded, {
      verbose: false,
    }).then(
      () => null,
      (e: unknown) => e as UnflakeExploreFailure,
    );

    expect(error).toBeInstanceOf(UnflakeExploreFailure);
    expect(error?.report.failure?.failure?.kind).toBe("invariant");
    // Breadth-first means the counterexample deviates from the natural
    // schedule as little as possible.
    expect(error?.report.failedOnSchedule).toBeLessThan(10);
  });

  it("agrees with the random search on the same program", async () => {
    // If exploration says a space is clean, sampling that space must never
    // find anything. Disagreement here would mean one of the two is wrong
    // about what executions are possible.
    const body = async (sim: Sim) => {
      let held = 0;
      sim.invariant("at most two in flight", () => held <= 2);
      await sim.parallel(2, async () => {
        held++;
        await sim.io("work", { latency: [1, 2] });
        held--;
      });
    };

    const explored = await explore("bounded concurrency", body, { verbose: false });
    expect(explored.exhaustive).toBe(true);
    expect(explored.ok).toBe(true);

    const { check } = await import("../src/runner.js");
    const sampled = await check("bounded concurrency", body, { runs: 300, verbose: false });
    expect(sampled.ok).toBe(true);
  });
});
