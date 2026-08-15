import { describe, expect, it } from "vitest";
import { simulate } from "../src/runner.js";

describe("kernel smoke", () => {
  it("runs a body to completion and advances virtual time", async () => {
    let reached = false;
    const result = await simulate(async (sim) => {
      await sim.sleep(1000);
      reached = true;
    });
    expect(result.ok).toBe(true);
    expect(reached).toBe(true);
    expect(result.time).toBe(1000);
  });

  it("routes patched setTimeout through virtual time", async () => {
    const result = await simulate(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 60 * 60 * 1000));
    });
    expect(result.ok).toBe(true);
    expect(result.time).toBe(3_600_000);
  });

  it("detects a deadlock instead of hanging", async () => {
    const result = await simulate(async () => {
      await new Promise<void>(() => {
        /* nothing will ever resolve this */
      });
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("deadlock");
  });

  it("catches an invariant the moment it stops holding", async () => {
    let counter = 0;
    const result = await simulate(async (sim) => {
      sim.invariant("counter stays below 3", () => counter < 3);
      await sim.parallel(5, async () => {
        counter++;
        await sim.sleep(1);
      });
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("invariant");
    expect(result.failure?.invariant).toBe("counter stays below 3");
  });

  it("restores every global it patched", async () => {
    const before = {
      setTimeout: globalThis.setTimeout,
      Date: globalThis.Date,
      random: Math.random,
      now: performance.now,
    };
    await simulate(async (sim) => {
      await sim.sleep(1);
    });
    expect(globalThis.setTimeout).toBe(before.setTimeout);
    expect(globalThis.Date).toBe(before.Date);
    expect(Math.random).toBe(before.random);
    expect(performance.now).toBe(before.now);
  });
});
