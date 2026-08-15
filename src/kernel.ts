/**
 * The scheduler.
 *
 * A normal async test hands control to the event loop and hopes. This one
 * keeps control: it drains the microtask queue, looks at every callback that
 * has become due at the current virtual instant, and *chooses* — from the
 * seed — which one runs next. Between every step it re-checks the invariants.
 *
 * That single change is what turns "fails once every few hundred CI runs" into
 * "fails at seed 0x8f3a2b1c, here is the twelve-step timeline". The bug was
 * always deterministic; what was random was which interleaving the operating
 * system happened to pick that day.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { TimerQueue, type Timer } from "./clock.js";
import { GlobalPatch, yieldToHost } from "./globals.js";
import { Rng, normalizeSeed, type Seed } from "./prng.js";
import { DecisionTape, EventLog } from "./trace.js";
import type { Failure, IoOptions, RunResult, Sim, SimulateOptions } from "./types.js";

/** Thrown by `sim.fail`. Carries no stack noise — the timeline is the report. */
export class SimAssertionError extends Error {
  override readonly name = "SimAssertionError";
}

interface TaskContext {
  name: string;
}

const DEFAULT_MAX_STEPS = 200_000;
const DEFAULT_MAX_VIRTUAL_TIME = 24 * 60 * 60 * 1000;

/** Only one simulation may own the globals at a time. */
let kernelActive = false;

export class Kernel {
  readonly queue = new TimerQueue();
  readonly seed: number;

  private readonly decisionRng: Rng;
  /**
   * `Math.random` and `sim.random` draw from a separate stream on purpose. If
   * user randomness shared the decision tape, calling `Math.random()` one
   * extra time would shift every later scheduling decision by one index and
   * invalidate shrinking mid-flight.
   */
  private readonly userRng: Rng;

  private readonly tape: DecisionTape;
  private readonly events: EventLog;
  private readonly patch: GlobalPatch;
  private readonly als = new AsyncLocalStorage<TaskContext>();
  private readonly invariants: { name: string; holds: () => boolean }[] = [];

  private readonly maxSteps: number;
  private readonly maxVirtualTime: number;

  private step = 0;
  private pendingTasks = 0;
  private readonly liveTasks = new Set<string>();
  private taskCounter = 0;
  private failure: Failure | null = null;

  constructor(options: SimulateOptions = {}) {
    this.seed = normalizeSeed((options.seed ?? 0) as Seed);
    this.decisionRng = new Rng(this.seed);
    this.userRng = new Rng(`user:${this.seed}`);
    this.tape = new DecisionTape(this.decisionRng, options.plan ?? [], options.planStrict ?? false);
    this.events = new EventLog(options.eventLimit ?? 5000);
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxVirtualTime = options.maxVirtualTime ?? DEFAULT_MAX_VIRTUAL_TIME;
    this.patch = new GlobalPatch({
      queue: this.queue,
      currentTask: () => this.currentTask(),
      random: () => this.userRng.float(),
    });
  }

  /**
   * Async-local storage gives exact attribution inside user code. The
   * scheduler itself runs outside any task context, so events it emits — a
   * broken invariant, most importantly — are attributed to the task whose
   * step just ran, which is the one that actually caused them.
   */
  private lastTask = "main";

  private currentTask(): string {
    return this.als.getStore()?.name ?? this.lastTask;
  }

  private emit(kind: Parameters<EventLog["push"]>[0]["kind"], text: string): void {
    this.events.push({
      step: this.step,
      time: this.queue.now,
      task: this.currentTask(),
      kind,
      text,
    });
  }

  private record(failure: Omit<Failure, "step" | "time">): void {
    // First failure wins. Later ones are usually consequences of the first,
    // and reporting the consequence instead of the cause is how debugging
    // sessions get wasted.
    if (this.failure) return;
    this.failure = { ...failure, step: this.step, time: this.queue.now };
    // The timeline gets a compact label; the full explanation is already
    // printed above it, and repeating a four-line paragraph inside a column
    // of one-line events destroys the thing that makes the timeline legible.
    this.emit("invariant", shorten(this.failure));
  }

  private checkInvariants(): void {
    if (this.failure) return;
    for (const inv of this.invariants) {
      let held: boolean;
      try {
        held = inv.holds();
      } catch (cause) {
        this.record({
          kind: "invariant",
          invariant: inv.name,
          message: `invariant "${inv.name}" threw: ${describe(cause)}`,
          cause,
        });
        return;
      }
      if (!held) {
        this.record({
          kind: "invariant",
          invariant: inv.name,
          message: `invariant "${inv.name}" no longer holds`,
        });
        return;
      }
    }
  }

  /** Seeded ordering of the callbacks that came due at the same instant. */
  private orderBatch(timers: Timer[]): Timer[] {
    if (timers.length <= 1) return timers;
    const remaining = [...timers];
    const ordered: Timer[] = [];
    while (remaining.length > 1) {
      const index = this.tape.decide("order", `${remaining.length} ready`, remaining.length);
      const [picked] = remaining.splice(index, 1);
      if (picked) ordered.push(picked);
    }
    const last = remaining[0];
    if (last) ordered.push(last);
    return ordered;
  }

  private async fire(timer: Timer): Promise<void> {
    this.step++;
    this.lastTask = timer.task;
    await this.als.run({ name: timer.task }, async () => {
      this.emit("resume", timer.label);
      try {
        timer.callback(...timer.args);
      } catch (cause) {
        this.record({
          kind: "assertion",
          message: `uncaught error in ${timer.label}: ${describe(cause)}`,
          cause,
        });
      }
      // Let every promise continuation this callback unblocked run to its own
      // next suspension point before the scheduler makes another choice.
      await yieldToHost();
    });
  }

  private runTask<T>(name: string, body: () => Promise<T> | T): Promise<T> {
    this.pendingTasks++;
    this.liveTasks.add(name);
    return this.als.run({ name }, async () => {
      this.emit("spawn", "started");
      try {
        return await body();
      } finally {
        this.pendingTasks--;
        this.liveTasks.delete(name);
        this.emit("done", "finished");
      }
    });
  }

  private buildSim(): Sim {
    const kernel = this;
    return {
      get seed() {
        return kernel.seed;
      },
      get now() {
        return kernel.queue.now;
      },
      get task() {
        return kernel.currentTask();
      },

      sleep(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
          kernel.queue.schedule({
            delay: ms,
            callback: () => resolve(),
            task: kernel.currentTask(),
            label: `sleep(${ms}ms)`,
          });
        });
      },

      io<T>(label: string, options: IoOptions<T> = {}): Promise<T> {
        const { latency = [1, 20] as const, failRate = 0, error, run } = options;
        const [lo, hi] = typeof latency === "number" ? [latency, latency] : latency;
        // Draw the fault first so that "does it fail" and "how long it takes"
        // occupy stable tape positions regardless of the outcome.
        const fails = failRate > 0 ? kernel.chance(`${label} fails`, failRate) : false;
        const span = Math.max(0, Math.floor(hi) - Math.floor(lo));
        const offset = span > 0 ? kernel.tape.decide("latency", label, span + 1) : 0;
        const delay = Math.floor(lo) + offset;
        const task = kernel.currentTask();
        return new Promise<T>((resolve, reject) => {
          kernel.queue.schedule({
            delay,
            task,
            label: `${label}${fails ? " ✗" : ""} (${delay}ms)`,
            callback: () => {
              if (fails) {
                kernel.emit("fault", `${label} failed`);
                reject(error ? error() : new Error(`unflake: simulated failure in "${label}"`));
              } else {
                kernel.emit("io", `${label} completed`);
                resolve((run ? run() : undefined) as T);
              }
            },
          });
        });
      },

      spawn<T>(name: string, body: () => Promise<T> | T): Promise<T> {
        return kernel.runTask(`${name}#${++kernel.taskCounter}`, body);
      },

      parallel<T>(count: number, body: (index: number) => Promise<T> | T): Promise<T[]> {
        const tasks: Promise<T>[] = [];
        for (let i = 0; i < count; i++) {
          tasks.push(kernel.runTask(`task#${i}`, () => body(i)));
        }
        return Promise.all(tasks);
      },

      invariant(name: string, holds: () => boolean): void {
        kernel.invariants.push({ name, holds });
      },

      fail(message: string): never {
        // Recorded as well as thrown: user code that wraps the world in a
        // try/catch must not be able to swallow a failed assertion.
        kernel.record({ kind: "assertion", message });
        throw new SimAssertionError(message);
      },

      note(text: string): void {
        kernel.emit("note", text);
      },

      random(): number {
        return kernel.userRng.float();
      },

      pick<T>(label: string, options: readonly T[]): T {
        if (options.length === 0) throw new Error("unflake: sim.pick needs at least one option");
        const index = kernel.tape.decide("choice", label, options.length);
        return options[index] as T;
      },

      chance(label: string, probability: number): boolean {
        return kernel.chance(label, probability);
      },
    };
  }

  /**
   * A recorded coin flip. Resolution is fixed at 1/1000 so that value 0 always
   * means "did not happen" — the tame end that shrinking drives toward.
   */
  private chance(label: string, probability: number): boolean {
    if (probability <= 0) return false;
    if (probability >= 1) return true;
    const value = this.tape.decide("fault", label, 1000);
    return value >= Math.round(1000 * (1 - probability));
  }

  async run(body: (sim: Sim) => Promise<void> | void): Promise<RunResult> {
    if (kernelActive) {
      throw new Error("unflake: a simulation is already running — simulations cannot nest");
    }
    kernelActive = true;

    const onUnhandledRejection = (reason: unknown) => {
      this.record({
        kind: "unhandled-rejection",
        message: `unhandled promise rejection: ${describe(reason)}`,
        cause: reason,
      });
    };
    const proc = typeof process !== "undefined" ? process : undefined;
    proc?.on("unhandledRejection", onUnhandledRejection);
    this.patch.install();

    try {
      const sim = this.buildSim();
      // The rejection is handled here so an ordinary thrown assertion is a
      // recorded failure rather than a crashed process.
      this.runTask("main", () => body(sim)).catch((cause: unknown) => {
        if (cause instanceof SimAssertionError) return; // already recorded
        this.record({ kind: "assertion", message: describe(cause), cause });
      });

      // One drain before the loop lets the body run to its first suspension
      // point. After that every iteration ends inside `fire`, which drains on
      // its way out — so draining again here would buy nothing and cost a
      // macrotask round-trip per step, which is the dominant cost of a run.
      await yieldToHost();

      while (true) {
        this.checkInvariants();
        if (this.failure) break;
        if (this.pendingTasks === 0) break;

        if (this.step >= this.maxSteps) {
          this.record({
            kind: "budget",
            message: `step budget exhausted after ${this.maxSteps} steps — livelock, or a timer loop that never settles`,
          });
          break;
        }

        const batch = this.queue.dueBatch();
        if (!batch) {
          // Nothing is due, nothing is running, and the test never finished.
          // Either the code under test deadlocked, or it is blocked on
          // something outside the simulation's control.
          this.record({ kind: "deadlock", message: this.describeDeadlock() });
          break;
        }

        if (batch.time > this.maxVirtualTime) {
          this.record({
            kind: "budget",
            message: `virtual time budget exhausted at ${formatMs(batch.time)}`,
          });
          break;
        }

        this.queue.now = batch.time;
        let fired = false;
        for (const timer of this.orderBatch(batch.timers)) {
          if (!this.queue.consume(timer)) continue; // cancelled by an earlier callback
          fired = true;
          await this.fire(timer);
          this.checkInvariants();
          if (this.failure || this.pendingTasks === 0) break;
        }
        // A batch in which nothing ran would loop without ever yielding.
        // It should not be reachable — cancelling removes a timer from the
        // queue outright — but spinning the process is too high a price for
        // being wrong about that.
        if (!fired) await yieldToHost();
      }
    } finally {
      this.patch.restore();
      proc?.off("unhandledRejection", onUnhandledRejection);
      this.queue.clear();
      kernelActive = false;
    }

    return {
      seed: this.seed,
      ok: this.failure === null,
      failure: this.failure,
      steps: this.step,
      time: this.queue.now,
      events: this.events.all(),
      plan: this.tape.values(),
    };
  }

  private describeDeadlock(): string {
    const waiting = [...this.liveTasks];
    const who = waiting.length <= 6 ? waiting.join(", ") : `${waiting.slice(0, 6).join(", ")}, …`;
    return (
      `deadlock: ${waiting.length} task${waiting.length === 1 ? "" : "s"} still waiting ` +
      `(${who}), but nothing is scheduled to ever wake ` +
      `${waiting.length === 1 ? "it" : "them"}. ` +
      `If the code under test waits on real I/O — a socket, a file, a native ` +
      `driver — unflake cannot see it; route it through sim.io() instead.`
    );
  }
}

/** One-line form of a failure, for the timeline column. */
function shorten(failure: Failure): string {
  switch (failure.kind) {
    case "invariant":
      return `invariant "${failure.invariant}" broken`;
    case "deadlock":
      return "deadlock — nothing left to run";
    case "budget":
      return "budget exhausted";
    default:
      return failure.message.length > 80
        ? `${failure.message.slice(0, 79)}…`
        : failure.message;
  }
}

export function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 2)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
