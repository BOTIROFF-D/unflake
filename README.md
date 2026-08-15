# unflake

**Deterministic simulation testing for TypeScript.** Find the async bug, then reproduce it from a seed — every time, on every machine.

[![CI](https://github.com/BOTIROFF-D/unflake/actions/workflows/ci.yml/badge.svg)](https://github.com/BOTIROFF-D/unflake/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/unflake)](https://www.npmjs.com/package/unflake)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A518-blue)
![license](https://img.shields.io/badge/license-MIT-blue)

---

Your async test suite has bugs it cannot see. Not because they are subtle — because your operating system keeps handing you the same interleaving, and the one that breaks you turns up on a build server at 3am, once, and is never seen again.

The usual response is `test.retry(3)` and a shrug. But nothing about that bug was random. What was random is which of the thousands of legal orderings the scheduler happened to pick that night.

unflake takes the schedule away from the OS. Time, timers, `Math.random` and the order in which ready callbacks run all become values drawn from a seed. The same seed produces the same execution, byte for byte — so a failure stops being an anecdote and becomes an address.

## What a failure looks like

```
  ✗ concurrent transfers always complete
    seed 0x00000001 · found on run 1 of 100

    deadlock: 3 tasks still waiting (main, alice→bob#1, bob→alice#2), but nothing
    is scheduled to ever wake them.
    detected at step 2, t=1ms

    timeline
      0ms  main         ▸ started
      0ms  alice→bob#1  ▸ started
      0ms  bob→alice#2  ▸ started
      0ms  alice→bob#1  » holds alice, wants bob
      0ms  bob→alice#2  » holds bob, wants alice
      1ms  alice→bob#1  · read balance (1ms)
      1ms  alice→bob#1  ✓ read balance completed
      1ms  bob→alice#2  · read balance (1ms)
      1ms  bob→alice#2  ✓ read balance completed
      1ms  bob→alice#2  ! deadlock — nothing left to run

    reproduce
      await simulate(body, { plan: [], planStrict: true })
      or explore the same seed again: { seed: 0x00000001 }
```

Two things here are not available to an ordinary test runner.

The first is the word **deadlock**. A normal test does not fail on a lock cycle — it hangs, and five seconds later the runner prints `test timed out`, which tells you nothing about who was holding what. unflake owns the clock, so it can tell the difference between *slow* and *nothing can ever happen again*, and it knows the instant that becomes true.

The second is **step 2, t=1ms**. Virtual time is free. A retry policy that backs off for six hours costs six microseconds to test.

## Quickstart

```bash
npm install --save-dev unflake
```

```ts
import { check } from "unflake";
import { it } from "vitest"; // or node:test, jest, whatever you already use

it("never double-leases a connection", async () => {
  await check("a connection is never leased twice", async (sim) => {
    const pool = createPool(sim, { size: 2 });
    const held = new Map<string, number>();

    // Re-checked after every single scheduling step, not just at the end.
    sim.invariant("no connection is held twice", () =>
      [...held.values()].every((n) => n <= 1),
    );

    await sim.parallel(4, async () => {
      const conn = await pool.acquire();
      held.set(conn, (held.get(conn) ?? 0) + 1);
      await sim.io("query", { latency: [1, 6] });
      held.set(conn, (held.get(conn) ?? 0) - 1);
      pool.release(conn);
    });
  }, { runs: 200 });
});
```

`check` explores 200 different schedules. If one of them breaks the invariant, it shrinks the failure to the smallest schedule that still breaks it and throws a report like the one above. If none do, it returns quietly.

## How it works

Four moving parts, and no magic in any of them.

**One source of events.** During a run, `setTimeout`, `setInterval`, `setImmediate`, `Date`, `performance.now`, `process.hrtime` and `Math.random` are replaced. Every way your code can wait ends up in a single virtual timer queue, so "what happens next" is a question with exactly one owner.

**The scheduler chooses.** When several callbacks come due at the same virtual instant, they are all equally entitled to run first. unflake picks the order from the seed and writes the choice down. Between every step it re-checks your invariants, so a violation is caught at the interleaving that caused it rather than whenever the test next happens to look.

**Microtasks are left alone.** Promise resolution order is already fully specified and deterministic given the same sequence of operations. Reordering it would invent races the engine cannot actually produce, and a false positive costs more trust than a missed bug. unflake only explores the macrotask boundaries — which is where the real nondeterminism lives.

**Failures shrink.** Every choice is recorded as a small integer, and index 0 is always the tamest option at each site: the natural order, the minimum latency, no fault. So shrinking is just "push values toward zero and see whether it still fails". What survives is the shortest schedule that still breaks the code — and it is self-contained, reproducible from the plan alone, with no seed required.

## What it catches

Each of these lives in [`examples/`](./examples) as a runnable test: a plausible bug, the schedule that exposes it, and the fix clearing a wider search.

| Example | The bug | Why ordinary tests miss it |
| --- | --- | --- |
| [`connection-pool`](./examples/connection-pool.test.ts) | A pool validates a connection *before* removing it from the free list, so two callers get the same socket | The window is one `await` wide, and the OS almost never lands in it |
| [`stale-write`](./examples/stale-write.test.ts) | Two overlapping cache refreshes; the slower one lands last and overwrites newer data with older | Needs the fetches to finish in the opposite order from which they started |
| [`lock-order`](./examples/lock-order.test.ts) | Two transfers take the same two locks in opposite orders | The test does not fail, it hangs — and a timeout names no culprit |
| [`retry-double-charge`](./examples/retry-double-charge.test.ts) | A payment times out client-side, gets retried, and settles twice | The abandoned request lands after the test has already walked away |

## Proving, instead of sampling

`check` draws random schedules, so a clean result means *not found in 200 tries*. For a small enough test you can have something much stronger:

```ts
const report = await explore("a connection is never leased twice", body);
// { ok: true, schedules: 24, exhaustive: true }
```

`explore` enumerates the decision tree rather than sampling it. It runs, looks at which choices the run actually made, and queues the prefix that takes each untaken alternative. When the queue empties on its own, `exhaustive` is true — and then a passing result is not "no failure was found" but **no failure exists**, for every execution the model can produce.

The bound is the whole story, so be precise about what it covers. The model is macrotask ordering, virtual time, and the choices unflake records — not the machine. And the space has to be small enough to finish: there is no partial-order reduction here, so the tree grows multiplicatively, and a wide `latency: [1, 25]` is a 25-way branch at every I/O. Narrow the ranges for the tests you want to exhaust, and use `check` for the rest.

## API

```ts
simulate(body, options?): Promise<RunResult>
```
Run once under a controlled world. Never throws on failure — it returns the result.

```ts
check(name, body, options?): Promise<CheckReport>
```
Explore many seeds. Throws `UnflakeFailure` with a formatted report on the first counterexample, after shrinking it.

Options: `runs` (default 200), `seed`, `shrink` (default true), `shrinkAttempts` (500), `maxSteps` (200,000), `maxVirtualTime` (24h), `plan` / `planStrict` for replay, `verbose`.

```ts
explore(name, body, options?): Promise<ExploreReport>
```
Enumerate schedules systematically instead of sampling them. Throws `UnflakeExploreFailure` on a counterexample; otherwise returns `{ schedules, exhaustive }`, where `exhaustive: true` means the space was covered completely. Options: `maxSchedules` (default 5,000), `onSchedule` for progress, plus the shared ones above.

The `sim` handed to your body:

| | |
| --- | --- |
| `sim.sleep(ms)` | wait in virtual time — free, however long |
| `sim.io(label, opts)` | simulated async work: `latency: [min, max]`, `failRate`, `run` |
| `sim.spawn(name, fn)` | an independently scheduled task |
| `sim.parallel(n, fn)` | `n` concurrent tasks |
| `sim.invariant(name, fn)` | a condition re-checked after every step |
| `sim.fail(msg)` | fail the run; cannot be swallowed by a `catch` |
| `sim.note(text)` | add a line to the timeline |
| `sim.pick(label, opts)` / `sim.chance(label, p)` | seeded, recorded, shrinkable choices |
| `sim.random()` | seeded replacement for `Math.random` |

## Limits

These are the things unflake genuinely cannot do. They are here rather than at the bottom of a wiki page because a testing tool that oversells its guarantees is worse than no tool at all.

**It only sees what it controls.** If your code awaits a real socket, a real file, or a native driver, the scheduler has no idea that work is outstanding — and a run with nothing left to schedule looks exactly like a deadlock. Route real I/O through `sim.io()` or a fake. The deadlock message says so, because this is the mistake everyone makes first.

**`check` cannot prove absence.** 500 runs is 500 schedules out of a space that is astronomically larger. A clean `check` means *not found*, not *impossible*. Treat it the way you treat a passing fuzz run. `explore` is the one that can prove a negative, and only when it reports `exhaustive: true`.

**No partial-order reduction.** `explore` enumerates systematically but does not *reduce*: unflake cannot see which operations touch shared state, so it cannot prove two orderings equivalent and skip one. The tree grows multiplicatively and exhaustive coverage stays out of reach for anything but small tests. Rust's `loom` does reduce, because code under test uses loom's own atomics and mutexes and it therefore sees every shared access. Matching that in JavaScript would mean asking users to declare their shared resources — a real design cost, and the main open question for this project.

**No real parallelism.** Node is single-threaded and so is the simulator. Races between worker threads, between processes, or inside native addons are out of scope. This is about *concurrency* bugs, not *parallelism* bugs.

**Microtask-level races are out of scope,** by the design choice described above.

**One simulation at a time per process.** The patched globals are process-wide, so nested or concurrent `simulate` calls throw rather than silently corrupting each other. Separate test files in separate workers are fine.

## Prior art

Deterministic simulation is not a new idea — it is a well-established one that has, oddly, never reached JavaScript.

[FoundationDB](https://apple.github.io/foundationdb/testing.html) built its entire language around it and shipped a database whose correctness story is mostly "we simulated it". [TigerBeetle](https://github.com/tigerbeetle/tigerbeetle)'s VOPR does the same for a financial ledger. [Antithesis](https://antithesis.com/) sells it as a deterministic hypervisor. In Rust, [`loom`](https://github.com/tokio-rs/loom) explores interleavings exhaustively with partial-order reduction, [`shuttle`](https://github.com/awslabs/shuttle) does it randomly, and [`madsim`](https://github.com/madsim-rs/madsim) simulates a whole async runtime. [Jepsen](https://jepsen.io/) attacks the problem from the outside instead.

In JavaScript the closest thing is [`@sinonjs/fake-timers`](https://github.com/sinonjs/fake-timers), which controls *time* — but not which of several ready callbacks goes first, which is where the bugs are. unflake is closest in spirit to `madsim`, minus the guarantees a language like Rust can enforce.

## Contributing

```bash
npm install
npm test          # 33 tests, including the determinism and exhaustiveness suites
npm run typecheck
npm run build
```

Two suites carry the claims, and they are the ones to be careful with.

[`test/determinism.test.ts`](./test/determinism.test.ts) pins the promise everything else rests on: same seed, byte-identical run; a recorded plan replays without the seed; and different seeds really do produce different schedules, so the search is a search and not an expensive way to run one test 200 times.

[`test/explore.test.ts`](./test/explore.test.ts) pins the exhaustiveness claim against spaces small enough to count by hand — three simultaneous tasks must yield exactly six schedules, all distinct, and all six orderings must actually occur. That last check is not redundant: a branching bug that skips a subtree still reports `exhaustive: true`, just with a smaller number, and it caught exactly that during development.

If a change breaks either suite, it is the change that is wrong.

## License

MIT
