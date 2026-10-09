# Z10 delivery ledger slice 2a: compaction boundary rows result

**Date:** 2026-10-08  
**Scope:** engineering scope from the [Z10 draft](./2026-09-30-z10-ledger-prereg.md), "Slice 2a: engineering scope (settled)". No task or efficacy claim.  
**Verdict:** the test files named below pass, the hand-driven sequence gives the expected rows, and stdout is identical with the delivery ledger on and off. This slice sets no latency bound.  
**Status:** the delivery ledger stays off by default behind `deliveryLedger.enabled`.

## What was built

The delivery ledger now writes one boundary row for each accepted call of `hippo pre-compact` and `hippo compact-resume`. No schema change: `event_type` has no CHECK constraint (`src/db/migrations/v50.ts:7`), and `DeliveryEventType` gains `pre-compact` and `compact-resume` (`src/delivery-recorder.ts:8`). `ledger_version` moves from 1 to 2 (`src/delivery-recorder.ts:20`). One duplicate rule covers both boundary types (`src/recall-trace.ts:307`, `:320`). The recorder starter is shared (`src/cli/shared.ts:482`). `pre-compact` records through an `onBoundary` callback (`src/capture/compact.ts:129-134`, `src/cli/session-hooks.ts:678-689`). `compact-resume` records in `cmdCompactResume` (`src/cli/session-hooks.ts:127-141`, `:172-177`). What each hook prints, saves and exits with is unchanged.

## What ran

Run at `44a6995f` plus the comment restore `e2a1e2b5`, on node v24.13.0.

```
npm --prefix C:/Users/skf_s/hippo-wt-z10b run build
npm --prefix C:/Users/skf_s/hippo-wt-z10b run test:delivery-ledger
```

- `npm run test:delivery-ledger`: 7 files, 116 tests, all pass (rerun for this document).
- Targeted vitest list of 9 files (the delivery-ledger files, `tests/prompt-hook-context.test.ts`, `tests/copilot-hooks-cli.test.ts`, `tests/hook-store-open-count.test.ts`, `tests/stdin-bounded.test.ts`): 226 pass, 0 fail. This count comes from the build run on this branch; it was not rerun for this document.
- Red first: tests B3 and B7 failed on the old code (B3 found 0 rows; B7 found 3 of 5). W1 and W6 failed for both boundary types before the duplicate rule existed.
- Mutations, each caught: the duplicate rule limited to `pre-compact` (caught by the `compact-resume` W1 and W6 cases); the boundary callback moved ahead of the early returns in `runPreCompact` (8 tests failed); no try/catch around the callback (only U1 failed); no flush before `process.exit` in `cmdCompactResume` (4 tests failed).
- Store-open count for `compact-resume`: `{local: 1}` with the delivery ledger on and with it off (`tests/hook-store-open-count.test.ts`).

The full suite was not run here. CI runs the full suite on the pull request.

## Hand-driven sequence

Driver: `C:/hippo-tmp/z10-slice2a/driver.mjs seq`, outside the repo. It builds two scratch projects, one with the delivery ledger on and one off, each with its own `HIPPO_HOME`. It sends the B7 order with session `seq1`: prompt, the same prompt again, `pre-compact`, `compact-resume`, prompt. The prompt hook is `hippo context --pinned-only --include-recent 5 --format additional-context`. A fresh snapshot of the session is saved before `compact-resume`.

`delivery_events` of the ledger-on project, in id order:

| id | event_type | block_state | turn_seq | session_state | ledger_version |
|---|---|---|---|---|---|
| 1 | prompt-submit | sent | 1 | payload | 2 |
| 2 | prompt-submit | reused | 2 | payload | 2 |
| 3 | pre-compact | sent | 1 | payload | 2 |
| 4 | compact-resume | sent | 1 | payload | 2 |
| 5 | prompt-submit | sent | 3 | payload | 2 |

The states match the expected list `sent`, `reused`, `sent`, `sent`, `sent`. The ledger-off project holds no `delivery_events` rows.

Stdout, ledger on against off, same inputs:

| Step | Exit on / off | Stdout bytes on / off | Identical |
|---|---|---|---|
| prompt | 0 / 0 | 195 / 195 | yes, raw |
| prompt again | 0 / 0 | 0 / 0 | yes, raw |
| `pre-compact` | 0 / 0 | 469 / 469 | yes, raw |
| `compact-resume` | 0 / 0 | 417 / 417 | yes, after masking ISO timestamps |
| prompt | 0 / 0 | 453 / 453 | yes, after masking ISO timestamps |

No run printed a delivery ledger stderr line. The raw `compact-resume` bytes differ only in ISO timestamps, which the mask removes, as test B9 does.

## On/off medians

Driver: `C:/hippo-tmp/z10-slice2a/driver.mjs time`. Per hook, 20 runs with the delivery ledger on and 20 off, in two scratch projects with identical stores. Each loop step runs the on arm and the off arm back to back, and the order flips every step, so load noise reaches both arms alike. Each run uses a fresh session id, so no run is a duplicate. The time is wall-clock milliseconds of the spawned CLI process, taken with `process.hrtime.bigint()`, and includes node start-up. `pre-compact` gets a Claude Code payload with a readable transcript. `compact-resume` gets `source: compact` and a fresh snapshot of the same session, saved before the timer starts, and every run printed the snapshot. The ledger-on project ended with 20 `pre-compact` and 20 `compact-resume` rows.

Node v24.13.0. Times in ms.

| Hook | Median on | Median off | Min on / off | Max on / off | On minus off (median) |
|---|---|---|---|---|---|
| `pre-compact` | 533 | 493 | 236 / 264 | 1591 / 2012 | +40.0 |
| `compact-resume` | 466 | 462 | 237 / 244 | 1936 / 2228 | +4.5 |

The box was under heavy load from other work during these runs. The spread inside one arm (236 to 2012 ms) is far larger than either difference, and the slice 1 A/A check showed that identical arms already differ by tens of milliseconds at this scale ([slice 1 result](./2026-10-03-z10-ledger-slice1-result.md)). So the two differences are not evidence of a cost or of none. This slice sets no latency bound.

## Not done

- No full-suite run here. CI runs it on the pull request.
- No latency bound, and no quiet-machine run. The medians above come from a loaded box.
- No in-process timing of the boundary write, as slice 1 did with `scripts/ledger-overhead.mjs`.
- The `session-end` event, the `recall_trace_id` and `query_hash` fields, tool-failure events and a `--runtime codex` flag are later slices.
- The Codex runtime label gap stays: a Codex `compact-resume` row reads `claude-code` unless the payload has a turn id.
- A missing boundary row is a gap, never evidence that no compaction happened. Remote-caller copies write no row.
