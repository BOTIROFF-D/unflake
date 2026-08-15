/**
 * unflake pointed at other people's code.
 *
 * Every case below asserts something the package's own documentation
 * promises — not something that would merely be nice. A finding is only worth
 * anyone's attention if the package claims the opposite of what happens, and
 * a "bug report" that turns out to be a misreading of the README costs more
 * credibility than it could ever buy.
 *
 * Result so far: all of them hold. See ./README.md for what that does and
 * does not mean, including the one case that looked like a violation and was
 * not.
 *
 * Written in JavaScript on purpose. This suite exercises the runtime
 * behaviour of seven third-party packages; pinning their type surfaces as
 * well would add a maintenance tax on every one of their releases without
 * telling us anything more about whether their contracts hold.
 */

import { describe, expect, it } from "vitest";
import { check } from "unflake";
import pLimit from "p-limit";
import PQueue from "p-queue";
import { Mutex, Semaphore, E_CANCELED } from "async-mutex";
import { Sema } from "async-sema";
import genericPool from "generic-pool";
import pRetry from "p-retry";
import Bottleneck from "bottleneck";

const RUNS = Number(process.env.AUDIT_RUNS ?? 150);

/** Run a contract and fail the test with unflake's report if it breaks. */
async function holds(claim, body) {
  const report = await check(claim, body, { runs: RUNS, verbose: false });
  expect(report.ok).toBe(true);
}

describe("p-limit", () => {
  // "Run multiple promise-returning & async functions with limited concurrency."
  it("never runs more than `concurrency` at once", async () => {
    await holds("p-limit respects concurrency", async (sim) => {
      const limit = pLimit(2);
      let active = 0;
      sim.invariant("at most 2 active", () => active <= 2);
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          limit(async () => {
            active++;
            await sim.io(`work-${i}`, { latency: [1, 6] });
            active--;
          }),
        ),
      );
    });
  });

  it("keeps activeCount within concurrency", async () => {
    await holds("p-limit activeCount stays bounded", async (sim) => {
      const limit = pLimit(3);
      sim.invariant("activeCount <= 3", () => limit.activeCount <= 3);
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => limit(() => sim.io(`work-${i}`, { latency: [1, 5] }))),
      );
    });
  });
});

describe("p-queue", () => {
  it("never runs more than `concurrency` at once", async () => {
    await holds("p-queue respects concurrency", async (sim) => {
      const queue = new PQueue({ concurrency: 2 });
      let active = 0;
      sim.invariant("at most 2 active", () => active <= 2);
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          queue.add(async () => {
            active++;
            await sim.io(`job-${i}`, { latency: [1, 6] });
            active--;
          }),
        ),
      );
    });
  });

  it("resolves onIdle only when nothing is left running", async () => {
    await holds("p-queue onIdle means idle", async (sim) => {
      const queue = new PQueue({ concurrency: 2 });
      let active = 0;
      for (let i = 0; i < 6; i++) {
        void queue.add(async () => {
          active++;
          await sim.io(`job-${i}`, { latency: [1, 6] });
          active--;
        });
      }
      await queue.onIdle();
      if (active !== 0) sim.fail(`onIdle resolved with ${active} jobs still running`);
      if (queue.size !== 0 || queue.pending !== 0) {
        sim.fail(`onIdle resolved with size=${queue.size} pending=${queue.pending}`);
      }
    });
  });

  // "intervalCap — The max number of runs in the given interval of time."
  it("starts at most intervalCap tasks per interval", async () => {
    await holds("p-queue respects intervalCap", async (sim) => {
      const interval = 20;
      const intervalCap = 2;
      const queue = new PQueue({ concurrency: 10, interval, intervalCap });
      const starts = [];
      sim.invariant(`at most ${intervalCap} starts per ${interval}ms`, () => {
        const cutoff = sim.now - interval;
        return starts.filter((t) => t > cutoff).length <= intervalCap;
      });
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          queue.add(async () => {
            starts.push(sim.now);
            await sim.io(`job-${i}`, { latency: [1, 4] });
          }),
        ),
      );
    });
  });

  // "pause() — Put queue execution on hold."
  it("starts nothing while paused", async () => {
    await holds("p-queue honours pause", async (sim) => {
      const queue = new PQueue({ concurrency: 2 });
      let paused = false;
      let startedWhilePaused = 0;
      sim.invariant("nothing starts while paused", () => startedWhilePaused === 0);
      for (let i = 0; i < 6; i++) {
        void queue.add(async () => {
          if (paused) startedWhilePaused++;
          await sim.io(`job-${i}`, { latency: [1, 5] });
        });
      }
      await sim.sleep(2);
      paused = true;
      queue.pause();
      await sim.sleep(30);
      paused = false;
      queue.start();
      await queue.onIdle();
    });
  });

  it("returns pending to zero after per-operation timeouts", async () => {
    await holds("p-queue settles after timeouts", async (sim) => {
      const queue = new PQueue({ concurrency: 2, timeout: 10, throwOnTimeout: true });
      const settled = await Promise.allSettled(
        Array.from({ length: 4 }, (_, i) => queue.add(() => sim.io(`job-${i}`, { latency: [1, 30] }))),
      );
      if (settled.length !== 4) sim.fail("lost a settled result");
      await queue.onIdle();
      if (queue.pending !== 0 || queue.size !== 0) {
        sim.fail(`after onIdle: pending=${queue.pending} size=${queue.size}`);
      }
    });
  });
});

describe("async-mutex", () => {
  it("gives exclusive access", async () => {
    await holds("async-mutex is exclusive", async (sim) => {
      const mutex = new Mutex();
      let holders = 0;
      sim.invariant("at most one holder", () => holders <= 1);
      await sim.parallel(5, async (i) => {
        await mutex.runExclusive(async () => {
          holders++;
          await sim.io(`critical-${i}`, { latency: [1, 6] });
          holders--;
        });
      });
    });
  });

  it("releases the lock when the body throws", async () => {
    await holds("async-mutex releases on throw", async (sim) => {
      const mutex = new Mutex();
      let holders = 0;
      sim.invariant("at most one holder", () => holders <= 1);
      await sim.parallel(4, async (i) => {
        try {
          await mutex.runExclusive(async () => {
            holders++;
            await sim.io(`critical-${i}`, { latency: [1, 4] });
            holders--;
            if (i % 2 === 0) throw new Error("boom");
          });
        } catch {
          // half of them throw on purpose; the lock must still come free
        }
      });
      if (mutex.isLocked()) sim.fail("mutex still locked after every holder finished");
    });
  });

  it("stays usable after cancelling pending waiters", async () => {
    await holds("async-mutex survives cancel", async (sim) => {
      const mutex = new Mutex();
      let holders = 0;
      sim.invariant("at most one holder", () => holders <= 1);

      const holder = sim.spawn("holder", async () => {
        const release = await mutex.acquire();
        holders++;
        await sim.io("critical", { latency: [4, 8] });
        holders--;
        release();
      });
      const waiters = Array.from({ length: 3 }, (_, i) =>
        sim.spawn(`waiter-${i}`, async () => {
          try {
            await mutex.runExclusive(async () => {
              holders++;
              await sim.io(`critical-${i}`, { latency: [1, 3] });
              holders--;
            });
          } catch (error) {
            if (error !== E_CANCELED) throw error;
          }
        }),
      );

      await sim.sleep(2);
      mutex.cancel();
      await Promise.all([holder, ...waiters]);

      if (mutex.isLocked()) sim.fail("mutex still locked after cancel and release");
      await mutex.runExclusive(async () => {
        holders++;
        await sim.io("after-cancel", { latency: [1, 2] });
        holders--;
      });
    });
  });

  it("admits at most N through a Semaphore", async () => {
    await holds("async-mutex Semaphore bounds concurrency", async (sim) => {
      const semaphore = new Semaphore(3);
      let active = 0;
      sim.invariant("at most 3 active", () => active <= 3);
      await sim.parallel(7, async (i) => {
        const [, release] = await semaphore.acquire();
        active++;
        await sim.io(`slot-${i}`, { latency: [1, 5] });
        active--;
        release();
      });
    });
  });
});

describe("async-sema", () => {
  it("admits at most N", async () => {
    await holds("async-sema bounds concurrency", async (sim) => {
      const sema = new Sema(2);
      let active = 0;
      sim.invariant("at most 2 active", () => active <= 2);
      await sim.parallel(6, async (i) => {
        await sema.acquire();
        active++;
        await sim.io(`slot-${i}`, { latency: [1, 5] });
        active--;
        sema.release();
      });
    });
  });
});

describe("generic-pool", () => {
  const factory = () => ({ create: async () => ({}), destroy: async () => {} });

  it("never lends the same resource twice", async () => {
    await holds("generic-pool never double-lends", async (sim) => {
      let created = 0;
      const pool = genericPool.createPool(
        { create: async () => `res-${created++}`, destroy: async () => {} },
        { min: 0, max: 2, autostart: false, evictionRunIntervalMillis: 0 },
      );
      const held = new Map();
      sim.invariant("no resource held twice", () => [...held.values()].every((n) => n <= 1));
      await sim.parallel(5, async (i) => {
        const resource = await pool.acquire();
        held.set(resource, (held.get(resource) ?? 0) + 1);
        await sim.io(`use-${i}`, { latency: [1, 5] });
        held.set(resource, (held.get(resource) ?? 0) - 1);
        await pool.release(resource);
      });
      await pool.drain();
      await pool.clear();
    });
  });

  it("never creates more resources than max", async () => {
    await holds("generic-pool respects max", async (sim) => {
      let live = 0;
      const pool = genericPool.createPool(
        {
          create: async () => {
            live++;
            return `res-${live}`;
          },
          destroy: async () => {
            live--;
          },
        },
        { min: 0, max: 3, autostart: false, evictionRunIntervalMillis: 0 },
      );
      sim.invariant("live resources <= max", () => live <= 3);
      await sim.parallel(8, async (i) => {
        const resource = await pool.acquire();
        await sim.io(`use-${i}`, { latency: [1, 5] });
        await pool.release(resource);
      });
      await pool.drain();
      await pool.clear();
    });
  });

  // A timed-out acquire must not strand the resource it was waiting for.
  it("does not strand a resource when an acquire times out", async () => {
    await holds("generic-pool survives acquire timeouts", async (sim) => {
      const pool = genericPool.createPool(factory(), {
        min: 0,
        max: 1,
        autostart: false,
        evictionRunIntervalMillis: 0,
        acquireTimeoutMillis: 8,
      });

      const hog = sim.spawn("hog", async () => {
        const resource = await pool.acquire();
        await sim.io("long-use", { latency: [20, 26] });
        await pool.release(resource);
      });
      const starved = sim.spawn("starved", async () => {
        try {
          const resource = await pool.acquire();
          await pool.release(resource);
        } catch {
          // timing out is the documented outcome here
        }
      });
      await Promise.all([hog, starved]);

      const outcome = await Promise.race([
        pool
          .acquire()
          .then((r) => pool.release(r))
          .then(() => "available"),
        sim.sleep(60).then(() => "stranded"),
      ]);
      if (outcome !== "available") sim.fail("pool never handed the resource out again");

      await pool.drain();
      await pool.clear();
    });
  });
});

describe("p-retry", () => {
  it("calls the function exactly retries+1 times before giving up", async () => {
    await holds("p-retry attempts the documented number of times", async (sim) => {
      let calls = 0;
      const retries = 3;
      sim.invariant(`at most ${retries + 1} attempts`, () => calls <= retries + 1);
      try {
        await pRetry(
          async () => {
            calls++;
            await sim.io("attempt", { latency: [1, 3] });
            throw new Error("always fails");
          },
          { retries, minTimeout: 1, maxTimeout: 4, factor: 2 },
        );
        sim.fail("pRetry resolved even though every attempt threw");
      } catch {
        // expected
      }
      if (calls !== retries + 1) sim.fail(`expected ${retries + 1} attempts, saw ${calls}`);
    });
  });

  it("stops calling once an attempt succeeds", async () => {
    await holds("p-retry stops on success", async (sim) => {
      let calls = 0;
      await pRetry(
        async () => {
          calls++;
          await sim.io("attempt", { latency: [1, 3] });
          if (calls < 2) throw new Error("first one fails");
          return "ok";
        },
        { retries: 5, minTimeout: 1, maxTimeout: 4 },
      );
      if (calls !== 2) sim.fail(`expected 2 attempts, saw ${calls}`);
    });
  });
});

describe("bottleneck", () => {
  it("never exceeds maxConcurrent", async () => {
    await holds("bottleneck respects maxConcurrent", async (sim) => {
      const limiter = new Bottleneck({ maxConcurrent: 2, minTime: 1 });
      let active = 0;
      sim.invariant("at most 2 active", () => active <= 2);
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          limiter.schedule(async () => {
            active++;
            await sim.io(`job-${i}`, { latency: [1, 5] });
            active--;
          }),
        ),
      );
    });
  });

  // Steady-state only. The very first gap is shorter than minTime by the
  // limiter's start-up cost, which is not a scheduling defect — see
  // ./README.md, "The one that looked like a bug".
  it("keeps launches after the first at least minTime apart", async () => {
    await holds("bottleneck respects minTime in steady state", async (sim) => {
      const minTime = 10;
      const limiter = new Bottleneck({ maxConcurrent: 1, minTime });
      const launches = [];
      limiter.on("executing", () => launches.push(sim.now));
      sim.invariant(`steady-state launches >= ${minTime}ms apart`, () => {
        for (let i = 2; i < launches.length; i++) {
          if (launches[i] - launches[i - 1] < minTime) return false;
        }
        return true;
      });
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          limiter.schedule(() => sim.io(`job-${i}`, { latency: [1, 4] })),
        ),
      );
    });
  });
});
