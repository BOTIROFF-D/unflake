import type { Decision, TraceEvent } from "./trace.js";

/** How a run went wrong. Each kind maps to a different failure report. */
export type FailureKind =
  | "assertion" // sim.fail(), or a thrown error / rejected promise
  | "invariant" // a registered invariant stopped holding
  | "deadlock" // nothing left to run and the test never finished
  | "budget" // step or virtual-time budget exhausted (usually a livelock)
  | "unhandled-rejection";

export interface Failure {
  kind: FailureKind;
  message: string;
  /** The invariant's name, when kind is "invariant". */
  invariant?: string;
  /** The original thrown value, when there was one. */
  cause?: unknown;
  /** Scheduler step at which the failure was detected. */
  step: number;
  /** Virtual milliseconds elapsed when the failure was detected. */
  time: number;
}

export interface RunResult {
  seed: number;
  ok: boolean;
  failure: Failure | null;
  steps: number;
  /** Virtual milliseconds elapsed. */
  time: number;
  events: readonly TraceEvent[];
  /** The decision values this run made — replay this to reproduce it exactly. */
  plan: number[];
  /**
   * The same decisions with their kind, label and bound. `plan` is what you
   * replay; this is what tells you which *other* choices existed at each
   * point, which is what systematic exploration needs in order to know when
   * it has seen the whole space.
   */
  decisions: readonly Decision[];
}

export interface SimulateOptions {
  seed?: number | string;
  /** Replay a specific decision sequence instead of drawing from the seed. */
  plan?: readonly number[];
  /**
   * With a plan, treat every decision past its end as 0 (the tamest option)
   * rather than drawing from the seed. This is what makes a shrunk failure
   * self-contained: the plan alone reproduces it.
   */
  planStrict?: boolean;
  /** Scheduler steps before the run is declared a livelock. Default 200,000. */
  maxSteps?: number;
  /** Virtual milliseconds before the run is declared stuck. Default 24 hours. */
  maxVirtualTime?: number;
  /**
   * Real milliseconds before the run gives up. Virtual time is free, so a
   * simulation can burn minutes of wall clock without its virtual clock
   * looking unusual — and a run that never returns leaves the patched globals
   * in place and breaks every test after it. Default 30,000.
   */
  maxWallClockMs?: number;
  /** Timeline events retained for the failure report. Default 5,000. */
  eventLimit?: number;
}

export interface CheckOptions extends SimulateOptions {
  /** How many seeds to explore before declaring the property held. Default 200. */
  runs?: number;
  /** Shrink a failing run to a minimal schedule. Default true. */
  shrink?: boolean;
  /** Cap on shrink attempts, so a pathological case cannot run forever. Default 500. */
  shrinkAttempts?: number;
  /** Print progress and the failure report to stderr. Default true. */
  verbose?: boolean;
}

export interface IoOptions<T = void> {
  /**
   * Simulated duration in virtual ms: a fixed number, or a `[min, max]` range
   * the scheduler draws from. Ranges are what create interleaving — two
   * operations with overlapping ranges will finish in either order across
   * seeds.
   */
  latency?: number | readonly [number, number];
  /** Probability in [0, 1] that this operation fails instead of succeeding. */
  failRate?: number;
  /** Builds the error thrown on failure. Defaults to a generic I/O error. */
  error?: () => Error;
  /** Produces the resolved value, called when the operation completes. */
  run?: () => T;
}

/**
 * The simulated world handed to a test body.
 *
 * Anything that waits should wait through here (or through ordinary timers,
 * which are patched to route here anyway). Waiting on something the scheduler
 * cannot see — a real socket, a real file — looks exactly like a deadlock,
 * because from the simulation's point of view it is one.
 */
export interface Sim {
  /** The seed driving this run. */
  readonly seed: number;
  /** Virtual milliseconds since the run started. */
  readonly now: number;
  /** The logical task currently executing. */
  readonly task: string;

  /** Wait for virtual time to pass. Free — a week costs nothing. */
  sleep(ms: number): Promise<void>;

  /** A unit of simulated async work: takes time, may fail, may be reordered. */
  io<T = void>(label: string, options?: IoOptions<T>): Promise<T>;

  /** Run `body` as an independently scheduled task. */
  spawn<T>(name: string, body: () => Promise<T> | T): Promise<T>;

  /** Run `count` concurrent copies of `body`, one task each. */
  parallel<T>(count: number, body: (index: number) => Promise<T> | T): Promise<T[]>;

  /**
   * Register a condition that must hold continuously. It is re-checked after
   * every scheduling step, so a violation is caught at the interleaving that
   * caused it rather than whenever the test happens to look.
   */
  invariant(name: string, holds: () => boolean): void;

  /** Fail the run immediately with a message. */
  fail(message: string): never;

  /** Add a line to the failure timeline. */
  note(text: string): void;

  /** Seeded replacement for `Math.random`. */
  random(): number;

  /** Seeded choice, recorded on the decision tape so it can be shrunk. */
  pick<T>(label: string, options: readonly T[]): T;

  /** Seeded coin flip, recorded on the decision tape. False is the tame side. */
  chance(label: string, probability: number): boolean;
}
