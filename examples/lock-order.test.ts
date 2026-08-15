/**
 * Two locks, taken in opposite orders.
 *
 * The oldest deadlock in the book, and still shipping in production, because
 * the two functions that disagree about lock order are usually written months
 * apart by different people and never appear in the same file.
 *
 * What makes this example worth having is not that unflake finds it — it is
 * what happens without unflake. An ordinary test does not fail here: it hangs.
 * The runner eventually gives up and prints "test timed out after 5000ms",
 * which tells you nothing about who was holding what. Because the simulator
 * owns the clock, it can tell the difference between "slow" and "nothing can
 * ever happen again", and it knows that the instant it becomes true.
 */

import { describe, expect, it } from "vitest";
import { check } from "../src/index.js";
import type { Sim } from "../src/index.js";
import { expectFailure } from "./_expect-failure.js";

function mutex(name: string) {
  let held = false;
  const waiters: (() => void)[] = [];
  return {
    name,
    async lock(): Promise<void> {
      while (held) await new Promise<void>((resolve) => waiters.push(resolve));
      held = true;
    },
    unlock(): void {
      held = false;
      waiters.shift()?.();
    },
  };
}

/** Transfers money by locking the source account, then the destination. */
const transfer = async (sim: Sim, from: ReturnType<typeof mutex>, to: ReturnType<typeof mutex>) => {
  await from.lock();
  sim.note(`locked ${from.name}`);
  await sim.io("read balance", { latency: [1, 5] });
  await to.lock();
  sim.note(`locked ${to.name}`);
  await sim.io("write balance", { latency: [1, 5] });
  to.unlock();
  from.unlock();
};

describe("lock ordering", () => {
  it("reports a deadlock instead of hanging until the runner gives up", async () => {
    const error = await expectFailure(
      check(
        "concurrent transfers always complete",
        async (sim) => {
          const alice = mutex("alice");
          const bob = mutex("bob");
          await Promise.all([
            sim.spawn("alice→bob", () => transfer(sim, alice, bob)),
            sim.spawn("bob→alice", () => transfer(sim, bob, alice)),
          ]);
        },
        { runs: 100, verbose: false },
      ),
    );

    expect(error.report.failure?.failure?.kind).toBe("deadlock");
    // Both transfers must be named as stuck — a deadlock report that does not
    // say who is waiting is only marginally better than a timeout.
    expect(error.report.failure?.failure?.message).toContain("alice→bob");
    expect(error.report.failure?.failure?.message).toContain("bob→alice");
  });

  it("clears the version that agrees on a lock order", async () => {
    const report = await check(
      "ordered transfers always complete",
      async (sim) => {
        const alice = mutex("alice");
        const bob = mutex("bob");
        // Both directions take the locks in the same order. That is the whole
        // fix, and it is why lock hierarchies exist.
        const ordered = async () => {
          await alice.lock();
          await sim.io("read balance", { latency: [1, 5] });
          await bob.lock();
          await sim.io("write balance", { latency: [1, 5] });
          bob.unlock();
          alice.unlock();
        };
        await Promise.all([sim.spawn("alice→bob", ordered), sim.spawn("bob→alice", ordered)]);
      },
      { runs: 300, verbose: false },
    );
    expect(report.ok).toBe(true);
  });
});
