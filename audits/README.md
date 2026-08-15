# Audits

unflake pointed at other people's code: **19 documented contracts across 7 widely-used async packages**, each searched over hundreds of schedules.

```bash
npm run audit:contracts              # 150 schedules per contract
AUDIT_RUNS=2000 npm run audit:contracts
```

| Package | Contracts checked |
| --- | --- |
| [`p-limit`](https://github.com/sindresorhus/p-limit) | concurrency bound, `activeCount` accuracy |
| [`p-queue`](https://github.com/sindresorhus/p-queue) | concurrency bound, `onIdle` really means idle, `intervalCap` per interval, `pause()` starts nothing, `pending` returns to zero after per-operation timeouts |
| [`async-mutex`](https://github.com/DirtyHairy/async-mutex) | mutual exclusion, release on throw, usable after `cancel()`, `Semaphore` bound |
| [`async-sema`](https://github.com/vercel/async-sema) | concurrency bound |
| [`generic-pool`](https://github.com/coopernurse/node-pool) | never double-lends, respects `max`, a timed-out acquire strands nothing |
| [`p-retry`](https://github.com/sindresorhus/p-retry) | exactly `retries + 1` attempts, stops on success |
| [`bottleneck`](https://github.com/SGrondin/bottleneck) | `maxConcurrent` bound, steady-state `minTime` spacing |

## The result: nothing found

Every contract held. That is the honest headline, and it is worth stating plainly rather than quietly not mentioning it.

It is also roughly what should have been expected. These are mature packages with millions of weekly downloads, and their core contracts are exercised by every single user. A tool that claimed to find bugs in `p-limit`'s concurrency bound on its first afternoon would be telling you more about the tool's calibration than about `p-limit`.

What the null result does establish is smaller but real: unflake drives seven third-party packages — with their own timers, their own promise plumbing, their own datastores and evictors — without any of them needing to know it exists. The suite is kept in the repository as continuous evidence of that, and as the place any future finding will land.

## The one that looked like a bug

Worth recording, because the process matters more than the outcome.

The first pass flagged `bottleneck`: with `minTime: 10`, two jobs launched **9ms** apart. An invariant broke, unflake produced a seed and a timeline, and the whole thing looked like a rate limiter letting a burst through — the exact class of bug that gets an API key banned.

Three checks before writing any of it down:

**Does it reproduce off the simulator?** Yes — on real timers the gaps were 8 and 7ms, worse than simulated. So not an artefact of virtual time.

**Am I measuring the right thing?** The probe sat inside the job body, which could include scheduling delay that has nothing to do with the limiter. Re-measured at bottleneck's own `executing` event: identical timestamps. So not a measurement error either.

**Is it schedule-dependent?** No, and this is what settled it. Across 400 schedules the smallest first gap was 9ms — short by exactly 1ms, every time, never worse. And every gap *after* the first held at ≥ 10ms across 500 schedules.

That signature is start-up cost, not a scheduling defect: the limiter's internal clock starts before its first job finishes initialising, so the first interval absorbs the difference. The steady-state behaviour — the part that governs whether you exceed somebody's rate limit — is exact.

So it is not a bug, and it is not reported as one. The audit checks steady-state spacing and says in a comment why it skips the first gap.

Filing that as an issue would have cost a maintainer their afternoon over one millisecond of start-up, and cost this project the only thing that makes a bug report worth opening: a track record of not wasting people's time.
