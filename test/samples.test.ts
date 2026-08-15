/**
 * Prints the failure reports the README quotes.
 *
 * Run `npx vitest run test/samples` and paste. Keeping the samples generated
 * rather than hand-written means the README cannot quietly describe an output
 * format the tool stopped producing two refactors ago.
 */

import { it } from "vitest";
import { check, UnflakeFailure } from "../src/index.js";
import type { Sim } from "../src/index.js";

async function print(name: string, body: (sim: Sim) => Promise<void>, runs = 200): Promise<void> {
  await check(name, body, { runs, verbose: false }).catch((error: UnflakeFailure) =>
    process.stdout.write(`${error.message}\n`),
  );
}

it("prints the sample reports", async () => {
  await print("cache versions never go backwards", async (sim) => {
    const origin = { version: 0 };
    let cached = 0;
    let seen = 0;
    sim.invariant("the cache never serves a version older than one it already served", () => {
      seen = Math.max(seen, cached);
      return cached >= seen;
    });
    await sim.parallel(3, async (i) => {
      await sim.sleep(i * 2);
      origin.version = i + 1;
      const snapshot = origin.version;
      await sim.io("fetch origin", { latency: [1, 25] });
      cached = snapshot;
    });
  });

  await print("concurrent transfers always complete", async (sim) => {
    const makeLock = (name: string) => {
      let held = false;
      const waiters: (() => void)[] = [];
      return {
        name,
        async lock() {
          while (held) await new Promise<void>((r) => waiters.push(r));
          held = true;
        },
        unlock() {
          held = false;
          waiters.shift()?.();
        },
      };
    };
    const alice = makeLock("alice");
    const bob = makeLock("bob");
    const transfer = async (from: ReturnType<typeof makeLock>, to: ReturnType<typeof makeLock>) => {
      await from.lock();
      sim.note(`holds ${from.name}, wants ${to.name}`);
      await sim.io("read balance", { latency: [1, 5] });
      await to.lock();
      await sim.io("write balance", { latency: [1, 5] });
      to.unlock();
      from.unlock();
    };
    await Promise.all([
      sim.spawn("alice→bob", () => transfer(alice, bob)),
      sim.spawn("bob→alice", () => transfer(bob, alice)),
    ]);
  }, 100);
});
