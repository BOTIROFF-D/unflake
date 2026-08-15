/**
 * A connection pool that validates a connection before handing it out.
 *
 * This is a real pattern, not a strawman: pools ping idle connections because
 * a socket that has been sitting for ten minutes is quite likely dead, and
 * handing a dead one to a caller produces a much worse bug than the one below.
 *
 * The mistake is subtler than "forgot a lock". The connection is chosen, then
 * validated, and only *then* removed from the free list — so between the
 * choice and the removal there is an await, and during that await the pool
 * still believes the connection is free. Two callers arriving in that window
 * both walk away with the same socket.
 *
 * Under an ordinary test this passes: with one caller there is no window, and
 * with several the window is a fraction of a millisecond the OS almost never
 * lands in. Under unflake, "almost never" is just another schedule.
 */

import { describe, expect, it } from "vitest";
import { check } from "../src/index.js";
import type { Sim } from "../src/index.js";
import { expectFailure } from "./_expect-failure.js";

interface Pool {
  acquire(): Promise<string>;
  release(conn: string): void;
}

/** Validate-then-take. The await sits inside the critical section. */
function buggyPool(sim: Sim, size: number): Pool {
  const free = Array.from({ length: size }, (_, i) => `conn-${i}`);
  const waiters: (() => void)[] = [];

  return {
    async acquire() {
      while (free.length === 0) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      // Pick the connection we intend to hand out…
      const conn = free[free.length - 1] as string;
      // …check it is still alive…
      await sim.io("ping", { latency: [1, 4] });
      // …and only now take it off the free list. For the whole duration of
      // that ping the connection is both "chosen by us" and "free to all".
      const index = free.indexOf(conn);
      if (index !== -1) free.splice(index, 1);
      return conn;
    },
    release(conn) {
      free.push(conn);
      waiters.shift()?.();
    },
  };
}

/** Take-then-validate. Nothing is ever both ours and free. */
function fixedPool(sim: Sim, size: number): Pool {
  const free = Array.from({ length: size }, (_, i) => `conn-${i}`);
  const waiters: (() => void)[] = [];

  return {
    async acquire() {
      while (free.length === 0) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      const conn = free.pop() as string;
      await sim.io("ping", { latency: [1, 4] });
      return conn;
    },
    release(conn) {
      free.push(conn);
      waiters.shift()?.();
    },
  };
}

/** The same workload against either implementation. */
const workload = (make: (sim: Sim, size: number) => Pool) => async (sim: Sim) => {
  const pool = make(sim, 2);
  const held = new Map<string, number>();

  sim.invariant("no connection is held twice", () =>
    [...held.values()].every((count) => count <= 1),
  );

  await sim.parallel(4, async () => {
    const conn = await pool.acquire();
    held.set(conn, (held.get(conn) ?? 0) + 1);
    await sim.io("query", { latency: [1, 6] });
    held.set(conn, (held.get(conn) ?? 0) - 1);
    pool.release(conn);
  });
};

describe("connection pool", () => {
  it("finds the validate-then-take race and shrinks it to something readable", async () => {
    const error = await expectFailure(
      check("a connection is never leased twice", workload(buggyPool), {
        runs: 200,
        verbose: false,
      }),
    );

    expect(error.report.failure?.failure?.kind).toBe("invariant");
    expect(error.report.failure?.failure?.invariant).toBe("no connection is held twice");
    // Shrinking has to leave behind something a human can read in one sitting.
    expect(error.report.failure?.steps).toBeLessThan(40);
  });

  it("clears the fixed pool over a wider search", async () => {
    const report = await check("the fixed pool never double-leases", workload(fixedPool), {
      runs: 500,
      verbose: false,
    });
    expect(report.ok).toBe(true);
  });
});
