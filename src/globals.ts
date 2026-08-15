/**
 * Swapping the world out from under the code under test.
 *
 * The deal unflake offers is: don't rewrite your code, just run it in here.
 * That only works if the ordinary ways JavaScript waits — timers, immediates,
 * the clock, `Math.random` — all route through the simulation instead of the
 * operating system. So during a run these globals are replaced, and restored
 * exactly as they were afterwards, descriptors and all.
 *
 * What is deliberately *not* patched: microtasks. Promise resolution order is
 * already fully specified and deterministic given the same sequence of
 * operations, so reordering it would invent races the engine cannot actually
 * produce. Everything here is about the macrotask boundaries, where the real
 * nondeterminism lives.
 */

import type { TimerQueue } from "./clock.js";

/**
 * Captured at import time, before anything is patched — including before a
 * test runner's own fake timers get installed inside a test body. The
 * scheduler needs one genuine macrotask boundary to drain microtasks against,
 * and if that boundary were itself faked the whole simulation would stall.
 */
const realSetImmediate: ((fn: () => void) => unknown) | undefined =
  typeof globalThis.setImmediate === "function"
    ? globalThis.setImmediate.bind(globalThis)
    : undefined;
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/**
 * Yield to the host event loop exactly once. Crossing a macrotask boundary
 * guarantees the microtask queue was drained to empty first — including
 * microtasks queued by other microtasks — which is precisely the "let all
 * pending promise continuations run" primitive the scheduler is built on.
 */
export function yieldToHost(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (realSetImmediate) realSetImmediate(resolve);
    else realSetTimeout(resolve, 0);
  });
}

/**
 * Virtual time is reported to user code as an offset from a fixed wall-clock
 * instant rather than from zero. Starting at the epoch would put every
 * `new Date()` in January 1970, which breaks date handling in ways that have
 * nothing to do with the bug being hunted.
 */
export const SIM_EPOCH = Date.UTC(2024, 0, 1);

export interface GlobalHost {
  readonly queue: TimerQueue;
  currentTask(): string;
  random(): number;
}

interface Saved {
  target: object;
  key: PropertyKey;
  descriptor: PropertyDescriptor | undefined;
}

export class GlobalPatch {
  private saved: Saved[] = [];
  private installed = false;

  constructor(private readonly host: GlobalHost) {}

  private replace(target: object, key: PropertyKey, value: unknown): void {
    this.saved.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
    Object.defineProperty(target, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  install(): void {
    if (this.installed) throw new Error("unflake: globals already patched (nested simulate?)");
    this.installed = true;
    const { host } = this;
    const g = globalThis as Record<string, unknown>;

    const setTimeoutPatch = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) =>
      host.queue.schedule({
        // Node floors setTimeout at 1ms. Preserving that matters: it is what
        // makes `setTimeout(fn, 0)` land *after* a `setImmediate`, and code
        // that accidentally depends on the difference should keep depending
        // on it here, not be quietly fixed by the simulator.
        delay: Math.max(1, Number(delay) || 0),
        callback,
        args,
        task: host.currentTask(),
        label: `setTimeout(${Math.max(1, Number(delay) || 0)}ms)`,
      });

    const setIntervalPatch = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const period = Math.max(1, Number(delay) || 0);
      return host.queue.schedule({
        delay: period,
        callback,
        args,
        interval: period,
        task: host.currentTask(),
        label: `setInterval(${period}ms)`,
      });
    };

    const clear = (handle: unknown) => {
      if (handle == null) return;
      const id = typeof handle === "number" ? handle : Number(handle);
      if (Number.isFinite(id)) host.queue.cancel(id);
    };

    this.replace(g, "setTimeout", setTimeoutPatch);
    this.replace(g, "clearTimeout", clear);
    this.replace(g, "setInterval", setIntervalPatch);
    this.replace(g, "clearInterval", clear);

    if (typeof g["setImmediate"] === "function") {
      this.replace(g, "setImmediate", (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
        host.queue.schedule({
          // Delay 0, so immediates strictly precede any setTimeout — which is
          // the ordering Node gives you once you are already inside a timer or
          // I/O callback, and the one everyone's mental model assumes.
          delay: 0,
          callback,
          args,
          task: host.currentTask(),
          label: "setImmediate",
        }),
      );
      this.replace(g, "clearImmediate", clear);
    }

    const RealDate = Date;
    const simNow = () => SIM_EPOCH + host.queue.now;
    class SimDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(simNow());
        else super(...(args as ConstructorParameters<typeof Date>));
      }
      static override now(): number {
        return simNow();
      }
    }
    this.replace(g, "Date", SimDate);

    if (typeof g["performance"] === "object" && g["performance"] !== null) {
      const perf = g["performance"] as Record<string, unknown>;
      if (typeof perf["now"] === "function") {
        this.replace(perf, "now", () => host.queue.now);
      }
    }

    this.replace(Math, "random", () => host.random());

    // process.hrtime is how a good deal of instrumentation code measures
    // elapsed time; leaving it real would let wall-clock leak into results
    // that are supposed to be reproducible.
    const proc = g["process"] as { hrtime?: unknown } | undefined;
    if (proc && typeof proc.hrtime === "function") {
      const hrtime = (previous?: [number, number]): [number, number] => {
        const ns = Math.round(host.queue.now * 1e6);
        const current: [number, number] = [Math.floor(ns / 1e9), ns % 1e9];
        if (!previous) return current;
        let sec = current[0] - previous[0];
        let nsec = current[1] - previous[1];
        if (nsec < 0) {
          sec -= 1;
          nsec += 1e9;
        }
        return [sec, nsec];
      };
      hrtime.bigint = () => BigInt(Math.round(host.queue.now * 1e6));
      this.replace(proc as object, "hrtime", hrtime);
    }
  }

  restore(): void {
    if (!this.installed) return;
    // Reverse order, so a key patched twice ends up with its original value.
    for (let i = this.saved.length - 1; i >= 0; i--) {
      const entry = this.saved[i];
      if (!entry) continue;
      if (entry.descriptor) Object.defineProperty(entry.target, entry.key, entry.descriptor);
      else delete (entry.target as Record<PropertyKey, unknown>)[entry.key];
    }
    this.saved = [];
    this.installed = false;
  }
}
