# Z10 delivery ledger slice 1: overhead result

**Date:** 2026-10-03  
**Scope:** engineering bounds from the [Z10 draft](./2026-09-30-z10-ledger-prereg.md), "Slice 1: engineering scope (settled)". No task or efficacy claim.  
**Verdict:** stdout, token and bytes bounds PASS in every run. On the final code the p95 bound FAILS in every run, and the p50 bound passes only in the rebased run on a quieter machine (worst +13.4 ms). Runs 1 and 2 are dominated by load on the test machine; a fully quiet re-run is still owed.  
**Status: the overhead gate is open.** The p95 ratio bound FAILS in all four runs (1.44 to 1.75), and the `--contention` run is not reported. This gate blocks any decision to turn `deliveryLedger` on by default; it does not block merging this slice, which ships the flag off.

## Runner

```
npm run build
node scripts/hook-latency.mjs --ledger-compare --memories 2000 --runs 30
```

The store is the `mulberry32(0xa1)` 2000-memory store plus 5 pins, built once per promptRecall setting and copied for the ledger off and on arms, so both arms hold identical rows. Each turn runs the per-prompt hook command (`hippo context --pinned-only --include-recent 5 --format additional-context`) with the payload on stdin, ledger off then on (ABAB). There are 3 warm-up turns and 30 timed turns per mode. `fresh` uses a new session each turn; `steady` uses one session, so the static block is reused after the first turn. Wall clock includes Node start-up.

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

## Not done

- `--contention` (a child holding `BEGIN IMMEDIATE` for 30 ms in a loop) was stopped for low memory before its promptRecall-on cells. Its one finished promptRecall-off cell is in the scratch log only, and no rows-dropped figure is reported.
- A quiet-machine latency re-run with enough turns to pin p95; the rebased run still fails one p95 cell at 1.44.
