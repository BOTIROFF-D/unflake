/**
 * A cache refresh that can move backwards in time.
 *
 * Two refreshes overlap. The first reads version 1 from the origin and starts
 * a slow fetch. While it is in flight the origin advances to version 2, a
 * second refresh starts, and — being lucky with the network — lands first.
 * Then the first refresh finally returns and writes version 1 over it.
 *
 * The cache now serves data older than what it served a moment ago, and will
 * keep doing so until something else evicts it. Nothing crashed, no error was
 * logged, and every individual request succeeded. This class of bug is why
 * "we would have noticed" is not a testing strategy.
 *
 * It needs the two fetches to complete in the opposite order from which they
 * started, which is why an ordinary test almost never sees it: the fast path
 * is also the overwhelmingly common one.
 */

import { describe, expect, it } from "vitest";
import { check } from "../src/index.js";
import type { Sim } from "../src/index.js";
import { expectFailure } from "./_expect-failure.js";

interface Cache {
  refresh(): Promise<void>;
  readonly version: number;
}

/** Read the version, fetch, write it back unconditionally. */
function unguardedCache(sim: Sim, origin: { version: number }): Cache {
  let cached = 0;
  return {
    get version() {
      return cached;
    },
    async refresh() {
      const snapshot = origin.version;
      await sim.io("fetch origin", { latency: [1, 25] });
      // No comparison. Whichever fetch finishes last wins, and the one that
      // finishes last is not necessarily the one that started last.
      cached = snapshot;
    },
  };
}

/** Same shape, one comparison added. */
function guardedCache(sim: Sim, origin: { version: number }): Cache {
  let cached = 0;
  return {
    get version() {
      return cached;
    },
    async refresh() {
      const snapshot = origin.version;
      await sim.io("fetch origin", { latency: [1, 25] });
      if (snapshot > cached) cached = snapshot;
    },
  };
}

const workload = (make: (sim: Sim, origin: { version: number }) => Cache) => async (sim: Sim) => {
  const origin = { version: 0 };
  const cache = make(sim, origin);
  let highWaterMark = 0;

  sim.invariant("the cache never serves an older version than it already did", () => {
    highWaterMark = Math.max(highWaterMark, cache.version);
    return cache.version >= highWaterMark;
  });

  // Three overlapping refreshes, with the origin advancing between them.
  await sim.parallel(3, async (i) => {
    await sim.sleep(i * 2);
    origin.version = i + 1;
    await cache.refresh();
  });
};

describe("cache refresh", () => {
  it("finds the schedule where a stale fetch lands last", async () => {
    const error = await expectFailure(
      check("cache versions never go backwards", workload(unguardedCache), {
        runs: 300,
        verbose: false,
      }),
    );

    expect(error.report.failure?.failure?.kind).toBe("invariant");
    // The counterexample has to name a specific schedule, not just a seed.
    expect(error.report.failure?.plan.some((value) => value !== 0)).toBe(true);
  });

  it("clears the guarded cache over a wider search", async () => {
    const report = await check("guarded cache versions never go backwards", workload(guardedCache), {
      runs: 500,
      verbose: false,
    });
    expect(report.ok).toBe(true);
  });
});
