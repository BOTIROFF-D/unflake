# Changelog

## 0.3.0

### Fixed

- **Runs were up to 80× slower on hosts without `setImmediate`.** The scheduler
  yields to the host once per step, so that yield is the cost of the whole
  tool. The fallback was `setTimeout(fn, 0)` — and Node floors timer delays at
  one millisecond, turning a 15µs step into a 1.3ms one. A MessagePort
  round-trip is a macrotask with no minimum delay and measures the same 15µs,
  so it now sits between the two and the timer is a last resort that should
  never be reached.

  Found while investigating why the audit job took eight minutes in CI and
  three seconds locally — but it was *not* the cause of that. Normalised per
  unit of work, CI improved 1.8×, not 80×, which means those runners were
  never taking the fallback. A macrotask round-trip simply costs far more on a
  virtualised runner than on a laptop, and the audit was asking for too many
  schedules. That was fixed by lowering the CI schedule count; this entry is a
  real cliff found on the way, affecting hosts that genuinely lack
  `setImmediate`.

- The "a simulation is already running" error now names the cause people
  actually hit. Nesting two runs on purpose is rare; a test runner killing a
  slow run and leaving its globals patched is common, and every later run in
  that process then failed with a message about nesting.

### Added

- `maxWallClockMs` (default 30,000) — a real-time budget alongside the virtual
  one. Virtual time is free, so a runaway run looks healthy from the inside
  while burning real minutes; if the test runner kills it first the cleanup
  never happens and every later test fails for unrelated reasons. Now the
  kernel gives up on its own terms and restores the globals.

- `audits/` — unflake run against 19 documented contracts across seven
  third-party async packages (`p-limit`, `p-queue`, `async-mutex`,
  `async-sema`, `generic-pool`, `p-retry`, `bottleneck`). Every contract held;
  the null result is published rather than quietly omitted. Runs via
  `npm run audit:contracts` and in its own non-blocking CI job, because a
  third-party release should not turn this repository's build red.

## 0.2.0

### Added

- **`explore` — systematic schedule enumeration.** Where `check` samples random
  schedules, `explore` walks the decision tree: it runs, sees which choices the
  run made, and queues the prefix that takes each untaken alternative. When the
  queue empties before the schedule cap it reports `exhaustive: true`, which
  upgrades a passing result from "no failure was found" to "no failure exists"
  for every execution the model can produce.

  There is no partial-order reduction, so the tree grows multiplicatively and
  exhaustive coverage only reaches small tests. The README says so plainly
  rather than leaving it to be discovered.

- `RunResult.decisions` — each decision's kind, label and bound alongside the
  drawn value. `plan` is what you replay; this is what says which *other*
  choices existed, which is what the enumeration needs.

- `ExploreOptions.onSchedule` — a per-schedule callback, for progress on long
  enumerations and for asserting in tests that no schedule is ever run twice.

### Changed

- The failure report distinguishes runs from schedules, and omits the seed for
  enumerated counterexamples — an enumerated schedule is reproduced by its
  plan, and printing a seed would suggest a knob that does nothing.

## 0.1.0

First release.

- Deterministic scheduler: `setTimeout`, `setInterval`, `setImmediate`, `Date`,
  `performance.now`, `process.hrtime` and `Math.random` are replaced for the
  duration of a run, so every way code can wait lands in one virtual timer
  queue and the order of ready callbacks is drawn from a seed.
- `check` — explore many seeds, then shrink any counterexample to the smallest
  schedule that still fails.
- Oracles: invariant violation, deadlock, step and virtual-time budgets,
  unhandled rejection.
- Failure timeline with virtual timestamps and per-task attribution.
- Zero runtime dependencies.
