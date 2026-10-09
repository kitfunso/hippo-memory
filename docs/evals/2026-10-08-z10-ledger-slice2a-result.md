# Z10 delivery ledger slice 2a: compaction boundary rows result

**Date:** 2026-10-08  
**Scope:** engineering scope from the [Z10 draft](./2026-09-30-z10-ledger-prereg.md), "Slice 2a: engineering scope (settled)". No task or efficacy claim.  
**Verdict:** the test files named below pass, the hand-driven sequence gives the expected rows, and stdout is identical with the delivery ledger on and off. This slice sets no latency bound.  
**Status:** the delivery ledger stays off by default behind `deliveryLedger.enabled`.

## What was built

The delivery ledger now writes one boundary row for each accepted call of `hippo pre-compact` and `hippo compact-resume`. No schema change: `event_type` has no CHECK constraint (`src/db/migrations/v50.ts:10`), and `DeliveryEventType` gains `pre-compact` and `compact-resume` (`src/delivery-recorder.ts:10`). `ledger_version` moves from 1 to 2 (`src/delivery-recorder.ts:24`). One duplicate rule covers both boundary types (`src/store/recall-trace.ts:302`, `:315`). The recorder starter is shared (`src/cli/shared.ts:541`). `pre-compact` records through an `onBoundary` callback (`src/capture/compact.ts:128-133`, `src/cli/session-hooks.ts:673-684`). `compact-resume` records in `cmdCompactResume` (`src/cli/session-hooks.ts:96`, `:110`, `:146`). A boundary row carries no prompt hash whatever the payload holds (`src/delivery-recorder.ts:293`). What each hook prints, saves and exits with is unchanged.

## What ran

Run at `03acb61d`, after the merge of master `47ab85fd`, on node v24.13.0.

```
npm --prefix C:/Users/skf_s/hippo-wt-z10b run build
npm --prefix C:/Users/skf_s/hippo-wt-z10b run test:delivery-ledger
```

- `npm run test:delivery-ledger`: 6 files, 112 tests, all pass. Master removed `tests/delivery-ledger-config.test.ts` in #566.
- Regression vitest run of 9 files with `--maxWorkers=1`: `tests/compaction-pre-compact.test.ts`, `tests/compaction-callers.test.ts`, `tests/pre-compact-e2e.test.ts`, `tests/compact-resume-text.test.ts`, `tests/pilot-arm-hook.test.ts`, `tests/copilot-hooks-cli.test.ts`, `tests/prompt-hook-context.test.ts`, `tests/hook-store-open-count.test.ts`, `tests/stdin-bounded.test.ts`. Result: 9 files, 222 pass, 0 fail.
- Boundary rows carry no prompt facts: written red first in `tests/delivery-ledger-recorder.test.ts`. The two cases `R3 a pre-compact row keeps no prompt hash or length although the payload carries a prompt` and `R3 a compact-resume row keeps no prompt hash or length although the payload carries a prompt` failed before the fix; the control `R4 a prompt-submit row still carries the prompt hash and length` passed throughout.
- Red first: tests B3 and B7 failed on the old code (B3 found 0 rows; B7 found 3 of 5). W1 and W6 failed for both boundary types before the duplicate rule existed.
- Mutations, each caught: the duplicate rule limited to `pre-compact` (caught by the `compact-resume` W1 and W6 cases); the boundary callback moved ahead of the early returns in `runPreCompact` (8 tests failed); no try/catch around the callback (only U1 failed); no flush before `process.exit` in `cmdCompactResume` (4 tests failed).
- Store-open count for `compact-resume`: `{local: 1}` with the delivery ledger on and with it off (`tests/hook-store-open-count.test.ts`).
- Again at `018ce0ff`, after the merge of master `6bd104a5`, two vitest runs with `--maxWorkers=1`. `tests/delivery-ledger tests/recall-trace tests/elapsed-time-upper-bounds.test.ts`: 11 files, 168 pass; it covers every file `npm run test:delivery-ledger` selects. `tests/compaction-pre-compact.test.ts`, `tests/compaction-callers.test.ts`, `tests/pre-compact-e2e.test.ts`, `tests/compact-resume-text.test.ts`, `tests/hook-store-open-count.test.ts`, `tests/stdin-bounded.test.ts`, `tests/hooks.test.ts`: 7 files, 169 pass, 4 skipped. Not run again at that head: `tests/pilot-arm-hook.test.ts`, `tests/copilot-hooks-cli.test.ts`, `tests/prompt-hook-context.test.ts`.
- Again at `1deacaa7`, after the merge of master `1b906a5c`, the same two vitest runs: 11 files, 168 pass; 7 files, 170 pass, 4 skipped. Master's #653 put `writeDeliveryEvent` inside `withWriteScope`, so this run covers the duplicate rule on the combined function. The hand-driven sequence gave the table below at that head too. The file and line references in this note were checked again after the merge of master `472f4d43`.
- Again at `69a82c48`, after the merge of master `6cff7736`, the same two vitest runs: 11 files, 168 pass; 7 files, 170 pass, 4 skipped. Master's #683 replaced `withLedgerDb` plus `recordTokenUse` with `bookLedgerTurn`, so `restoreCompactSnapshot` now books its token row and flushes the `compact-resume` boundary row through that call. The hand-driven sequence, whose `compact-resume` step restores a snapshot and so takes that call, gave the table below at that head too. The file and line references in this note were checked again there.

The full suite was not run here. CI runs the full suite on the pull request. The hand-driven sequence below was run again at `018ce0ff`. The medians were taken at `3fe2473b` and were not run again.

## Hand-driven sequence

Driver: `C:/hippo-tmp/z10-slice2a/driver.mjs seq`, outside the repo. It builds two scratch projects, one with the delivery ledger on and one off, each with its own `HIPPO_HOME`. It sends the B7 order with session `seq1`: prompt, a second prompt with different text, `pre-compact`, `compact-resume`, prompt. The prompt hook is `hippo context --pinned-only --include-recent 5 --format additional-context`. A fresh snapshot of the session is saved before `compact-resume`.

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
| second prompt | 0 / 0 | 0 / 0 | yes, raw |
| `pre-compact` | 0 / 0 | 469 / 469 | yes, raw |
| `compact-resume` | 0 / 0 | 417 / 417 | yes, after masking ISO timestamps |
| prompt | 0 / 0 | 453 / 453 | yes, after masking ISO timestamps |

No run printed a delivery ledger stderr line. The raw `compact-resume` bytes differ only in ISO timestamps, which the mask removes, as test B9 does.

The driver first sent the same prompt text twice, and that form depends on timing. Two calls with one prompt hash inside `DELIVERY_DUPLICATE_WINDOW_MS` (2000 ms, `src/store/recall-trace.ts:236`) are one turn under the slice 1 rule (`src/store/recall-trace.ts:325-334`), so the second row gets no turn number and the last prompt gets turn 2. One run at `018ce0ff` gave exactly that. The earlier runs gave the table above, so their two calls were more than 2000 ms apart. The driver now sends a different second prompt, as B7 does, and the run at `018ce0ff` with that driver gave the table above.

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
- A boundary row has no `project_hash`. Only the context path hands project facts to the recorder (`src/api/context.ts:323`), so in a global store `session_id` is the one link from a boundary row to its project.
- A missing boundary row is a gap, never evidence that no compaction happened. Remote-caller copies write no row.
