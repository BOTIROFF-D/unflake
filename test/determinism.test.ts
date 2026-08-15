/**
 * The claim this project lives or dies by.
 *
 * unflake tells you that a failure will reproduce from its seed. That promise
 * is either true or the tool is worse than useless — a reproduction that only
 * usually works would send people chasing schedules that never existed. So
 * these tests do not check that the simulator is convenient; they check that
 * it is honest.
 *
 * Four things are pinned here:
 *   1. Same seed, same run — byte for byte, including the event text.
 *   2. A recorded plan replays to the same outcome without the seed.
 *   3. Different seeds really do produce different schedules, so the search
 *      is a search and not an expensive way to run one test 200 times.
 *   4. Nothing leaks out of a run, even when the run fails badly.
 */

import { describe, expect, it } from "vitest";
import { simulate } from "../src/runner.js";
import type { Sim } from "../src/index.js";

/**
 * A deliberately tangled workload: overlapping tasks, nested spawns, timers
 * scheduled from inside timers, an interval, a coin flip and a raw
 * `setTimeout` — every entry point the kernel patches, in one program.
 */
async function tangled(sim: Sim): Promise<void> {
  const log: string[] = [];
  let ticks = 0;

  const interval = setInterval(() => {
    ticks++;
  }, 7);

  await sim.parallel(4, async (i) => {
    await sim.sleep(i);
    await sim.io(`read-${i}`, { latency: [1, 12] });
    if (sim.chance(`retry-${i}`, 0.4)) {
      await sim.io(`retry-${i}`, { latency: [1, 6] });
    }
    await sim.spawn(`nested-${i}`, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 3));
      log.push(`${i}@${Date.now()}`);
      // Math.random is patched too — if it were not, this alone would make
      // every run below differ and the whole suite would fail.
      if (Math.random() > 0.5) await sim.sleep(2);
    });
  });

  clearInterval(interval);
  sim.note(`ticks=${ticks} log=${log.join(",")}`);
}

/** Everything about a run that a user could observe. */
function fingerprint(result: Awaited<ReturnType<typeof simulate>>): string {
  return JSON.stringify({
    ok: result.ok,
    steps: result.steps,
    time: result.time,
    plan: result.plan,
    failure: result.failure,
    events: result.events.map((e) => [e.step, e.time, e.task, e.kind, e.text]),
  });
}

describe("determinism", () => {
  it("produces byte-identical runs for the same seed", async () => {
    for (const seed of [0, 1, 7, 4242, 0xdeadbeef, "a-string-seed"]) {
      const first = await simulate(tangled, { seed });
      const second = await simulate(tangled, { seed });
      expect(fingerprint(second), `seed ${String(seed)} diverged`).toBe(fingerprint(first));
    }
  });

  it("stays identical when unrelated runs happen in between", async () => {
    const baseline = await simulate(tangled, { seed: 99 });
    for (let i = 0; i < 20; i++) await simulate(tangled, { seed: 1000 + i });
    const again = await simulate(tangled, { seed: 99 });
    expect(fingerprint(again)).toBe(fingerprint(baseline));
  });

  it("replays a recorded plan without needing the seed", async () => {
    const original = await simulate(tangled, { seed: 31337 });
    // A different seed entirely: if the plan is doing the work, the seed
    // cannot matter, because every decision is already spoken for.
    const replayed = await simulate(tangled, {
      seed: 12345,
      plan: original.plan,
      planStrict: true,
    });
    expect(replayed.steps).toBe(original.steps);
    expect(replayed.time).toBe(original.time);
    expect(replayed.plan).toEqual(original.plan);
  });

  it("actually explores different schedules across seeds", async () => {
    const shapes = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const result = await simulate(tangled, { seed });
      shapes.add(result.events.map((e) => `${e.task}:${e.kind}`).join("|"));
    }
    // If this ever collapses toward 1, the simulator has stopped searching
    // and every extra run is wasted electricity.
    expect(shapes.size).toBeGreaterThan(30);
  });

  it("keeps virtual time out of the wall clock", async () => {
    const result = await simulate(async (sim) => {
      const start = Date.now();
      const startPerf = performance.now();
      await sim.sleep(6 * 60 * 60 * 1000); // six virtual hours
      sim.note(`elapsed=${Date.now() - start}`);
      expect(Date.now() - start).toBe(6 * 60 * 60 * 1000);
      expect(performance.now() - startPerf).toBe(6 * 60 * 60 * 1000);
    });
    expect(result.ok).toBe(true);
    expect(result.time).toBe(21_600_000);
  });

  it("restores globals even when the run fails", async () => {
    const before = {
      setTimeout: globalThis.setTimeout,
      setInterval: globalThis.setInterval,
      clearTimeout: globalThis.clearTimeout,
      Date: globalThis.Date,
      random: Math.random,
    };
    const result = await simulate(async () => {
      throw new Error("boom");
    });
    expect(result.ok).toBe(false);
    expect(globalThis.setTimeout).toBe(before.setTimeout);
    expect(globalThis.setInterval).toBe(before.setInterval);
    expect(globalThis.clearTimeout).toBe(before.clearTimeout);
    expect(globalThis.Date).toBe(before.Date);
    expect(Math.random).toBe(before.random);
  });

  it("refuses to nest simulations rather than corrupting both", async () => {
    const result = await simulate(async () => {
      await expect(simulate(async () => {})).rejects.toThrow(/already running/);
    });
    expect(result.ok).toBe(true);
  });
});
