/**
 * Virtual clock and timer queue.
 *
 * In a simulation there is exactly one source of events: this queue. Real
 * `setTimeout` hands control back to the event loop and the OS decides when
 * you get it again; here nothing happens until the scheduler decides to
 * advance time, so "when did this fire relative to that" stops being luck.
 *
 * Time is virtual: advancing an hour costs nothing, which is why a test can
 * cover a day of retry backoff in a millisecond of wall clock.
 */

export interface Timer {
  id: number;
  /** Virtual timestamp (ms since simulation start) at which this fires. */
  dueAt: number;
  /** Insertion counter — the stable tiebreak that makes order 0 reproducible. */
  seq: number;
  callback: (...args: unknown[]) => void;
  args: unknown[];
  /** Repeat period for setInterval, otherwise null. */
  interval: number | null;
  /** Logical task that scheduled it, for timeline attribution. */
  task: string;
  /** Human label shown in the failure timeline. */
  label: string;
  cancelled: boolean;
}

/** The handle returned by the patched `setTimeout`/`setInterval`. */
export class TimerHandle {
  private refed = true;

  constructor(
    readonly id: number,
    private readonly queue: TimerQueue,
  ) {}

  /**
   * Node's timer handles carry ref/unref/refresh. Libraries call them
   * unprompted (connection pools unref their keepalive timers, HTTP agents
   * refresh them), and a handle that throws on `.unref()` would fail those
   * libraries for reasons that have nothing to do with their real behaviour.
   */
  unref(): this {
    this.refed = false;
    return this;
  }

  ref(): this {
    this.refed = true;
    return this;
  }

  hasRef(): boolean {
    return this.refed;
  }

  refresh(): this {
    this.queue.refresh(this.id);
    return this;
  }

  /** So that `clearTimeout(handle)` and `Number(handle)` both behave. */
  valueOf(): number {
    return this.id;
  }

  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

export class TimerQueue {
  private timers = new Map<number, Timer>();
  private nextId = 1;
  private seq = 0;

  /** Virtual milliseconds elapsed since the simulation started. */
  now = 0;

  schedule(spec: {
    delay: number;
    callback: (...args: unknown[]) => void;
    args?: unknown[];
    interval?: number | null;
    task: string;
    label: string;
  }): TimerHandle {
    const id = this.nextId++;
    // Negative and non-finite delays collapse to "as soon as possible". The
    // 1ms floor that Node applies to `setTimeout` lives in the global patch
    // rather than here, because `setImmediate` legitimately wants delay 0.
    const delay = Number.isFinite(spec.delay) && spec.delay > 0 ? Math.floor(spec.delay) : 0;
    this.timers.set(id, {
      id,
      dueAt: this.now + delay,
      seq: this.seq++,
      callback: spec.callback,
      args: spec.args ?? [],
      interval: spec.interval ?? null,
      task: spec.task,
      label: spec.label,
      cancelled: false,
    });
    return new TimerHandle(id, this);
  }

  cancel(id: number): void {
    const timer = this.timers.get(id);
    if (timer) {
      timer.cancelled = true;
      this.timers.delete(id);
    }
  }

  /** Node semantics: restart the timer's countdown from now. */
  refresh(id: number): void {
    const timer = this.timers.get(id);
    if (!timer) return;
    const period = timer.interval ?? timer.dueAt - this.now;
    timer.dueAt = this.now + Math.max(1, period);
    timer.seq = this.seq++;
  }

  get size(): number {
    return this.timers.size;
  }

  /**
   * Every timer due at the earliest pending timestamp, in stable insertion
   * order. They are all equally entitled to run first — which one actually
   * does is the scheduler's seeded decision, and the whole point of the
   * exercise.
   */
  dueBatch(): { time: number; timers: Timer[] } | null {
    if (this.timers.size === 0) return null;
    let earliest = Number.POSITIVE_INFINITY;
    for (const timer of this.timers.values()) {
      if (timer.dueAt < earliest) earliest = timer.dueAt;
    }
    const batch: Timer[] = [];
    for (const timer of this.timers.values()) {
      if (timer.dueAt === earliest) batch.push(timer);
    }
    batch.sort((a, b) => a.seq - b.seq);
    return { time: earliest, timers: batch };
  }

  /**
   * Remove a one-shot timer, or re-arm an interval. Returns false when the
   * timer was cancelled between being batched and being fired — which happens
   * constantly, since an earlier callback in the same batch may well have
   * cleared it.
   */
  consume(timer: Timer): boolean {
    const live = this.timers.get(timer.id);
    if (!live || live.cancelled) return false;
    if (timer.interval !== null) {
      live.dueAt = this.now + Math.max(1, timer.interval);
      live.seq = this.seq++;
    } else {
      this.timers.delete(timer.id);
    }
    return true;
  }

  /** Labels of everything still waiting — the evidence in a deadlock report. */
  pending(): { task: string; label: string; dueAt: number }[] {
    return [...this.timers.values()]
      .sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq)
      .map((t) => ({ task: t.task, label: t.label, dueAt: t.dueAt }));
  }

  clear(): void {
    this.timers.clear();
  }
}
