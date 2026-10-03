# Z10 delivery ledger slice 1: overhead result

**Date:** 2026-10-03  
**Scope:** engineering bounds from the [Z10 draft](./2026-09-30-z10-ledger-prereg.md), "Slice 1: engineering scope (settled)". No task or efficacy claim.  
**Verdict:** stdout, token and bytes bounds PASS in every run. On the final code the p95 bound FAILS in every run, and the p50 bound passes only in the rebased run on a quieter machine (worst +13.4 ms). Runs 1 and 2 are dominated by load on the test machine; the quiet re-runs are below.  
**Status: the overhead gate passes under Amendment 1.** The whole-process p95 ratio failed in all four original runs (1.44 to 1.75) and in the 100-turn quiet re-run, but an A/A run with the ledger off in both arms broke both latency bounds too, so that runner cannot decide them. Amendment 1 moved the latency bounds to an in-process timing of the ledger's own work: worst p50 1.49 ms against 15 ms, worst p95 2.09 ms against 30 ms.

## Runner

```
npm run build
npm run test:delivery-ledger
node scripts/hook-latency.mjs --ledger-compare --memories 2000 --runs 30
```

The store is the `mulberry32(0xa1)` 2000-memory store plus 5 pins, built once per promptRecall setting and copied for the ledger off and on arms, so both arms hold identical rows. Each turn runs the per-prompt hook command (`hippo context --pinned-only --include-recent 5 --format additional-context`) with the payload on stdin, ledger off then on (ABAB). The recorded runs used this fixed off-then-on order, so the p95 gate stays open, and the next measurement uses the runner's counterbalanced order (off first on even turns, on first on odd turns). There are 3 warm-up turns and 30 timed turns per mode. `fresh` uses a new session each turn; `steady` uses one session, so the static block is reused after the first turn. Wall clock includes Node start-up.

## Results

Times in ms. Bytes are store growth per turn after `PRAGMA wal_checkpoint(TRUNCATE)`, on minus off. Rows are `delivery_*` rows per turn.

| Run | promptRecall | Mode | p50 off / on | p95 off / on | p95 ratio | p50 delta | Bytes | Rows |
|---|---|---|---|---|---|---|---|---|
| pre-fallback | off | fresh | 332 / 460 | 599 / 1049 | 1.75 | +128.3 | 496 | 6 |
| pre-fallback | off | steady | 328 / 453 | 700 / 1065 | 1.52 | +124.7 | 745 | 6 |
| pre-fallback | on | fresh | 319 / 382 | 795 / 605 | 0.76 | +63.3 | 2607 | 27 |
| pre-fallback | on | steady | 365 / 425 | 729 / 650 | 0.89 | +59.7 | 2731 | 27 |
| 1 | off | fresh | 365 / 352 | 521 / 521 | 1.00 | -12.9 | 496 | 6 |
| 1 | off | steady | 552 / 620 | 1329 / 2186 | 1.64 | +68.0 | 745 | 6 |
| 1 | on | fresh | 836 / 668 | 1321 / 1816 | 1.38 | -168.3 | 2607 | 27 |
| 1 | on | steady | 519 / 527 | 740 / 904 | 1.22 | +7.3 | 2731 | 27 |
| 2 | off | fresh | 528 / 481 | 1345 / 1260 | 0.94 | -47.6 | 496 | 6 |
| 2 | off | steady | 304 / 324 | 474 / 457 | 0.96 | +20.5 | 745 | 6 |
| 2 | on | fresh | 383 / 391 | 529 / 723 | 1.37 | +8.2 | 2607 | 27 |
| 2 | on | steady | 507 / 534 | 747 / 1092 | 1.46 | +26.5 | 2731 | 27 |
| rebased | off | fresh | 334 / 343 | 572 / 823 | 1.44 | +8.8 | 496 | 6 |
| rebased | off | steady | 274 / 288 | 578 / 579 | 1.00 | +13.4 | 745 | 6 |
| rebased | on | fresh | 205 / 214 | 372 / 383 | 1.03 | +9.4 | 2607 | 27 |
| rebased | on | steady | 217 / 223 | 374 / 393 | 1.05 | +5.8 | 2731 | 27 |

In every run and cell, stdout matched in 100% of turns, the injected-token delta was 0, and no turn dropped a row or printed a ledger stderr line.

| Bound | Pre-fallback | Run 1 | Run 2 | Rebased |
|---|---|---|---|---|
| stdout identical, token delta 0 | PASS | PASS | PASS | PASS |
| p95 ratio <= 1.10 (worst) | FAIL 1.75 | FAIL 1.64 | FAIL 1.46 | FAIL 1.44 |
| p50 delta <= 15 ms (worst) | FAIL 128.3 | FAIL 68.0 | FAIL 26.5 | PASS 13.4 |
| bytes per turn <= 7168 (worst) | PASS 2731 | PASS 2731 | PASS 2731 | PASS 2731 |

The rebased run is the same command on the branch rebased onto 1.55.0 (`55b564a`), with about 28 GB free. Its one p95 failure is a single cell; with 33 turns, p95 is the second-slowest turn, so one slow turn sets it.

## What changed between the pre-fallback run and runs 1 and 2

The pre-fallback run showed a steady +60 to +128 ms p50. CPU profiles of 12 calls per arm put that cost on the ledger's own connection: the close checkpoint (+28 ms), the first write into a fresh WAL (+20 ms) and the WAL pragma on open (+9 ms). The plan's p95 fallback was applied: the event is now written on the token ledger's handle, with the lock wait lowered to 50 ms for that write. After the change, the same profile measured +1.5 ms per call. The bytes fallback was not needed.

## Why the latency verdict is not the ledger's cost

Runs 1 and 2 ran while other jobs on the machine held about 20 GB of memory, and the contention run that followed was stopped for low memory. Signs that noise dominates:

- The ledger-off arm alone moves from 304 to 836 ms p50 between cells.
- Three cells show the ledger-on arm faster, by up to 168 ms.
- The worst cell moves between runs: steady/off in run 1, steady/on in run 2.

None of this is a pass. The bounds stay FAIL as measured, and the latency gate is open until a run on a quiet machine.

## Quiet re-runs after 1.56.0

Same runner on the 1.56.0 build (`c3dc6cc`) with the counterbalanced order, `--contention` included, about 31 GB free and 2 of 24 cores busy with other jobs. Contention cells are reported but are not in the timed bounds.

| Run | promptRecall | Mode | p50 off / on | p95 off / on | p95 ratio | p50 delta | Bytes | Dropped |
|---|---|---|---|---|---|---|---|---|
| 30 turns | off | fresh | 235 / 222 | 408 / 419 | 1.02 | -13.6 | 496 | 0 |
| 30 turns | off | steady | 202 / 208 | 335 / 344 | 1.03 | +6.5 | 745 | 0 |
| 30 turns | off | contention | 247 / 216 | 484 / 501 | 1.04 | -30.9 | 496 | 0 |
| 30 turns | on | fresh | 209 / 220 | 321 / 350 | 1.09 | +10.9 | 2607 | 0 |
| 30 turns | on | steady | 203 / 207 | 354 / 364 | 1.03 | +3.7 | 2731 | 0 |
| 30 turns | on | contention | 211 / 220 | 390 / 484 | 1.24 | +8.5 | 2855 | 0 |
| 100 turns | off | fresh | 239 / 214 | 309 / 311 | 1.01 | -24.5 | 597 | 0 |
| 100 turns | off | steady | 218 / 209 | 335 / 404 | 1.21 | -8.5 | 756 | 0 |
| 100 turns | off | contention | 243 / 244 | 470 / 379 | 0.81 | +1.0 | 716 | 1 |
| 100 turns | on | fresh | 261 / 255 | 438 / 414 | 0.94 | -6.1 | 2744 | 0 |
| 100 turns | on | steady | 268 / 254 | 465 / 446 | 0.96 | -14.0 | 2943 | 0 |
| 100 turns | on | contention | 242 / 250 | 440 / 477 | 1.08 | +7.1 | 2784 | 0 |

The 30-turn run passes every bound (worst p95 ratio 1.09, worst p50 delta +10.9 ms). The 100-turn run fails the p95 bound at 1.21, while the ledger-on arm has the lower p50 in four of six cells. Stdout matched in every turn and the token delta was 0 in both runs. One contention turn in the 100-turn run dropped its event and printed the one-line ledger warning; the 50 ms lock wait expired, as designed.

**A/A check.** The same 100-turn command with `deliveryLedger` off in both arms (a temporary copy of the runner, not committed) gives p95 ratios of 1.00, 1.12, 0.91 and 1.23 across the four timed cells, 0.64 to 1.23 with contention, and a p50 delta of +44.3 ms in one cell. Two identical arms break both latency bounds, so whole-process wall clock at about 200 to 900 ms per turn cannot resolve a 10% p95 ratio or a 15 ms p50 delta against a profiled ledger cost of about 1.5 ms.

## In-process ledger time (Amendment 1)

[Amendment 1](./2026-09-30-z10-ledger-prereg.md) replaced the two latency bounds with the ledger's own time per turn, measured in one process, before this run (`cabfe25`). Runner: `node scripts/ledger-overhead.mjs --memories 2000 --runs 200`, 10 warm-ups, same machine and build as the re-runs above. Ledger time is recorder creation, time inside observer calls net of the admit they wrap, `delivered`, and the event write on the token ledger's handle after its inject row. Times in ms.

| promptRecall | Mode | Ledger p50 / p95 / max | Observer p95 | Write p95 | getContext p50 / p95 | Dropped |
|---|---|---|---|---|---|---|
| off | fresh | 1.09 / 1.58 / 2.8 | 0.89 | 0.60 | 40.9 / 57.2 | 0 / 200 |
| off | steady | 1.03 / 1.65 / 3.9 | 0.84 | 0.66 | 38.3 / 57.8 | 0 / 200 |
| off | contention | 1.52 / 13.26 / 95.7 | 1.24 | 12.14 | 51.6 / 76.5 | 0 / 200 |
| on | fresh | 1.33 / 2.03 / 13.7 | 0.85 | 1.01 | 59.1 / 95.7 | 0 / 200 |
| on | steady | 1.49 / 2.09 / 9.4 | 0.90 | 1.15 | 57.5 / 72.4 | 0 / 200 |
| on | contention | 1.23 / 10.24 / 74.8 | 0.93 | 9.57 | 46.2 / 71.1 | 0 / 200 |

| Bound (Amendment 1) | Worst | Verdict |
|---|---|---|
| ledger p50 <= 15 ms | 1.49 | PASS |
| ledger p95 <= 30 ms | 2.09 | PASS |

With the stdout, token and bytes bounds passing in every whole-process run above, every slice 1 overhead bound now passes. Under contention the write waits for the lock, so its tail reaches 96 ms; no event was dropped in 1200 in-process turns, against 1 in 103 contention turns of the 100-turn whole-process run. Not counted: the array spreads built at four `dropMissing` call sites before the observer is entered, and the timer's own overhead, which adds to the measured time.

## Not done

- The known limitations in the changelog (recent-window quality drops, empty or disabled turns opening their own connection, unsalted `prompt_hash`, null `recall_trace_id` and `query_hash`) are slice 2 and are not measured here.
