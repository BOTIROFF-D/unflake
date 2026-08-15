# Changelog

## Unreleased

### Added

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
