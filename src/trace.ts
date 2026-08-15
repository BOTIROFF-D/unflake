/**
 * The decision trace is what makes a failure portable.
 *
 * Every choice the simulation makes — which of two ready callbacks runs first,
 * how long an I/O takes, whether a fault fires — is drawn here and appended to
 * an array of small integers. Two properties are load-bearing:
 *
 *  1. Replay: re-running with the same seed replays the same integers, so a
 *     failure travels as a seed rather than as a "sometimes it happens" bug
 *     report.
 *  2. Shrinking: index 0 is always the tamest option at every call site — the
 *     natural order, the minimum latency, no fault. So the all-zeros plan is
 *     the boring schedule, and shrinking is just "push values toward zero and
 *     see if it still fails".
 *
 * The second property is a convention the call sites must honour, not
 * something the type system can enforce, so every `decide` caller in this
 * package is written to put its dullest choice at 0.
 */

import type { Rng } from "./prng.js";

export type DecisionKind = "order" | "latency" | "fault" | "choice";

export interface Decision {
  kind: DecisionKind;
  label: string;
  /** Number of available options; the drawn value lies in [0, bound). */
  bound: number;
  value: number;
}

export class DecisionTape {
  readonly decisions: Decision[] = [];
  /**
   * Pre-set values to replay. Where `plan[i]` exists it is used instead of a
   * fresh draw; beyond the plan the tape falls back to the rng. A shrunk
   * failure is exactly a short plan.
   */
  private readonly plan: readonly number[];

  /**
   * When strict, decisions past the end of the plan return 0 instead of
   * drawing from the rng. Shrinking depends on this: it makes "shorter plan"
   * mean "tamer schedule", so truncating the tail is a valid reduction and a
   * shrunk failure is fully described by the plan alone, with no seed needed.
   */
  private readonly strict: boolean;

  constructor(
    private readonly rng: Rng,
    plan: readonly number[] = [],
    strict = false,
  ) {
    this.plan = plan;
    this.strict = strict;
  }

  /**
   * Draw one decision in [0, bound). Value 0 must be the tamest option at
   * every call site — see the note at the top of this file.
   */
  decide(kind: DecisionKind, label: string, bound: number): number {
    if (bound <= 1) {
      this.decisions.push({ kind, label, bound: 1, value: 0 });
      return 0;
    }
    const i = this.decisions.length;
    const planned = i < this.plan.length ? this.plan[i] : this.strict ? 0 : undefined;
    // A planned value can exceed the bound after shrinking changes the code
    // path — clamp rather than throw, since the run is still meaningful.
    const value =
      planned === undefined ? this.rng.below(bound) : Math.min(Math.max(planned, 0), bound - 1);
    this.decisions.push({ kind, label, bound, value });
    return value;
  }

  /** The drawn values, in order — the portable form of this execution. */
  values(): number[] {
    return this.decisions.map((d) => d.value);
  }
}

export type EventKind =
  | "spawn"
  | "resume"
  | "io"
  | "fault"
  | "note"
  | "invariant"
  | "done";

export interface TraceEvent {
  step: number;
  /** Virtual milliseconds since the simulation started. */
  time: number;
  task: string;
  kind: EventKind;
  text: string;
}

/**
 * Ring buffer of what happened, used to render the failure timeline. Capped
 * because a run that fails on step 90,000 is not made clearer by printing the
 * first 89,000 steps — only the tail matters, and shrinking usually makes the
 * whole thing short anyway.
 */
export class EventLog {
  private readonly buffer: TraceEvent[] = [];

  constructor(private readonly limit = 5000) {}

  push(event: TraceEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.limit) this.buffer.shift();
  }

  all(): readonly TraceEvent[] {
    return this.buffer;
  }

  tail(n: number): readonly TraceEvent[] {
    return this.buffer.slice(Math.max(0, this.buffer.length - n));
  }
}
