/**
 * A retry that charges the card twice.
 *
 * The client gives the payment gateway 10ms, the gateway occasionally takes
 * longer, the client times out and retries. Nothing here is wrong on its own —
 * timeouts are correct, retries are correct. What is wrong is the assumption
 * hiding between them: that a request which timed out did not happen.
 *
 * It did happen. The gateway processed it; only the answer was late. So the
 * retry is a second charge, and the customer sees two line items for one
 * order. This is not a rare bug — it is one of the most common ways money
 * goes missing in distributed systems, and it is invisible to any test that
 * does not control when the slow response lands.
 */

import { describe, expect, it } from "vitest";
import { check } from "../src/index.js";
import type { Sim } from "../src/index.js";
import { expectFailure } from "./_expect-failure.js";

interface Gateway {
  charge(idempotencyKey: string): Promise<string>;
  readonly settled: number;
}

/** Processes whatever it receives. Late answers are still answers. */
function naiveGateway(sim: Sim): Gateway {
  let settled = 0;
  return {
    get settled() {
      return settled;
    },
    charge() {
      return sim.io("gateway charge", {
        latency: [1, 25],
        run: () => {
          settled++;
          return `receipt-${settled}`;
        },
      });
    },
  };
}

/** Remembers keys it has already settled, which is the entire fix. */
function idempotentGateway(sim: Sim): Gateway {
  let settled = 0;
  const receipts = new Map<string, string>();
  return {
    get settled() {
      return settled;
    },
    charge(key: string) {
      return sim.io("gateway charge", {
        latency: [1, 25],
        run: () => {
          const existing = receipts.get(key);
          if (existing) return existing;
          settled++;
          const receipt = `receipt-${settled}`;
          receipts.set(key, receipt);
          return receipt;
        },
      });
    },
  };
}

/** Race the call against a timer. The loser keeps running regardless. */
async function withTimeout<T>(sim: Sim, work: Promise<T>, ms: number): Promise<T> {
  let timedOut = false;
  const timeout = sim.sleep(ms).then(() => {
    timedOut = true;
    throw new Error(`timed out after ${ms}ms`);
  });
  // Swallow the loser's rejection so an abandoned attempt does not surface as
  // an unhandled rejection — that would be a different bug report than the
  // one this example is about.
  work.catch(() => {});
  timeout.catch(() => {});
  const result = await Promise.race([work, timeout]);
  if (timedOut) throw new Error("timed out");
  return result;
}

const workload = (make: (sim: Sim) => Gateway) => async (sim: Sim) => {
  const gateway = make(sim);
  const key = "order-4417";

  sim.invariant("an order is settled at most once", () => gateway.settled <= 1);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const receipt = await withTimeout(sim, gateway.charge(key), 10);
      sim.note(`attempt ${attempt} returned ${receipt}`);
      break;
    } catch {
      sim.note(`attempt ${attempt} timed out`);
    }
  }

  // Give the abandoned attempts time to land. Walking away early is exactly
  // how this bug survives code review: the test ends before the truth arrives.
  await sim.sleep(60);
};

describe("payment retries", () => {
  it("finds the schedule where a timed-out charge still settles", async () => {
    const error = await expectFailure(
      check("an order is charged at most once", workload(naiveGateway), {
        runs: 200,
        verbose: false,
      }),
    );

    expect(error.report.failure?.failure?.invariant).toBe("an order is settled at most once");
  });

  it("clears the gateway that honours an idempotency key", async () => {
    const report = await check(
      "an idempotent order is charged at most once",
      workload(idempotentGateway),
      { runs: 500, verbose: false },
    );
    expect(report.ok).toBe(true);
  });
});
