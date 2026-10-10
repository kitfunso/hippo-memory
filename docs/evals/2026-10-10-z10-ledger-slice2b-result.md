# Z10 delivery ledger slice 2b: session-end and context rows result

**Date:** 2026-10-10  
**Scope:** engineering scope from the [Z10 draft](./2026-09-30-z10-ledger-prereg.md), "Slice 2b: engineering scope (settled)". No task or efficacy claim.  
**Verdict:** the test files named below pass at `a08b39e7`, each of the nine mutations below fails a test, and `hippo context` prints byte-identical stdout with the delivery ledger on and off. This slice sets no latency bound.  
**Status:** the delivery ledger stays off by default behind `deliveryLedger.enabled`.

## What was built

Two more calls write a `delivery_events` row. No schema change. `DeliveryEventType` gains `session-end` and `context` (`src/store/delivery-recorder.ts:10`), and `ledger_version` moves from 2 to 3 (`src/store/delivery-recorder.ts:27`).

- **session-end.** `hippo session-end` starts a recorder only for a received, non-manual payload outside turn mode (`src/cli/session-hooks.ts:165`). It writes the row after the detached worker spawns, or after the inline fallback returns, inside `runHookWithStores` (`src/cli/session-hooks.ts:184`, `:189`). `session-end` is a boundary type, so it joins the 2000 ms duplicate rule (`src/store/delivery-recorder.ts:12`, `src/store/recall-trace.ts:315`).
- **context.** `hippo context` without `--pinned-only` records with event type `context` (`src/cli/context.ts:35`) and surface `context` (`src/store/delivery-recorder.ts:314`). Only the two prompt types keep prompt facts (`src/store/delivery-recorder.ts:15`).
- **Candidates.** Ranked results are offered to the observer before the limit and duplicate cuts, in pool `search` for a query and `strength` for none (`src/api/context.ts:453-455`). A returned row keeps that pool (`src/store/delivery-recorder.ts:246`).
- **Query hash.** The call reports its query (`src/api/context.ts:325`), and the recorder keeps `blockHash` of it (`src/store/delivery-recorder.ts:437`). The recall trace now hashes its query with the same function (`src/store/recall-trace.ts:81`), so the two columns join directly.
- **Trace id.** `SqliteLocal.finishLastRecall` now answers the id of the trace it wrote (`src/store/sqlite/local.ts:21`, `:39`), and the results path reports it (`src/api/context.ts:530`). The empty-result trace still goes through the store port's `finishRecall`, which answers nothing (`src/api/context.ts:491`), so an empty row links no trace id. `StorePort` is unchanged, and the store-port ratchet does not rise.

What `hippo context` and `hippo session-end` print, save and exit with is unchanged.

## What ran

Run at `a08b39e7`, rebased on master `beb79075`, on node v24.13.0.

```
npm --prefix C:/Users/skf_s/hippo-wt-z10c run build
npm --prefix C:/Users/skf_s/hippo-wt-z10c run test:delivery-ledger
```

- `npm run test:delivery-ledger`: 7 files, 137 tests, all pass. The new file is `tests/delivery-ledger-context.test.ts`.
- Regression vitest run with `--maxWorkers=2`: `tests/delivery-ledger`, `tests/session-end-`, `tests/recall-trace-`, `tests/api-context`, `tests/cli-context-`, `tests/context-`, plus `tests/api-outcome-for-last-recall.test.ts`, `tests/hook-store-open-count.test.ts`, `tests/hooks.test.ts`, `tests/copilot-hooks-cli.test.ts`, `tests/pilot-arm-hook.test.ts`, `tests/prompt-hook-context.test.ts`, `tests/lean-hook-context.test.ts`, `tests/stdin-bounded.test.ts`, `tests/compaction-pre-compact.test.ts`, `tests/pre-compact-e2e.test.ts`, `tests/server-context-route.test.ts`, `tests/server-outcome-route.test.ts`, `tests/mcp-context-scope.test.ts`, `tests/shared-store-context.test.ts`, `tests/codex-wrapper.test.ts`, `tests/goal-outcome-end-to-end.test.ts` and `tests/goal-outcome-propagation.test.ts`. Result: 55 files, 668 pass, 4 skipped.
- The CI check scripts, each exit 0: lint ratchet, comment history, error text, graph writes, import cycles, size, env reads, process exit, store port, layers, test-only exports, CLI recall writes, roadmap, agent inventory, request-path timing. `npm run typecheck:tests` is clean.
- Again after a rebase on master `988f0ea7`, at code head `f3ff1e30`: the build, the check scripts above plus master's new floating-promise check, each exit 0, and the test type-check. The regression run with two more files, `tests/cli-single-read-parity.test.ts` and `tests/store-port-check.test.ts`, gave 57 files, 705 pass, 4 skipped. The mutations and the timings were not run again there.
- Store-open count: equal with the delivery ledger on and off for `pre-compact` and for an agent-run `hippo context` (`tests/hook-store-open-count.test.ts`).
- Stdout of `hippo context` is byte-identical with the ledger on and off, for markdown, JSON and no query (C11 in `tests/delivery-ledger-context.test.ts`). The off store is a byte copy of the on store, since a retrieval strengthens the rows it returns.

### Mutations

Script: `C:/hippo-tmp/z10-slice2b/mutate.mjs`, outside the repo. It edits one built file in `dist/`, runs the named test file, and restores the file. It lists at most four failing tests per mutation. All nine were run again at `a08b39e7`, and each failed at least one test:

| Mutation | Caught by |
|---|---|
| results path reports no trace id | C1, C2, C6 |
| `finishLastRecall` answers no trace id | C1, C2, C6 |
| no query hash reported | C1 to C4 |
| ranked results not offered before the cuts | C1, C2, C5 |
| ranked pool relabelled `pin` or `recent` | C1, C2, C5 |
| session-end row on a manual run | E4 |
| session-end row in turn mode | E4 |
| context rows keep prompt facts | C9 |
| no session-end recorder | B7, E1, E2, E3 |

The turn-mode mutation survived the first run. E4 sent a SessionEnd payload with `--turn`, and turn mode drops anything that is not a VS Code Stop payload before the recorder's check (`src/cli/session-hooks.ts:157`). E4 now sends a Stop payload, which reaches the check.

### A regression the run caught

The first build sent the empty-result trace through a new `SqliteLocal.traceRecall`, written as `plan.obs?.traced(await onStore(...))`. Optional chaining skips the argument when there is no observer, so with the ledger off, the default, a query that returned nothing wrote no trace. `tests/recall-trace-wiring.test.ts` (F5) and `tests/context-store-path-parity.test.ts` failed on it. The store-port ratchet also flagged the new member. `a08b39e7` returns the empty path to master's `port.finishRecall` and removes `traceRecall`. Both tests pass, and the ratchet is flat.

## The call sequence

B7 in `tests/delivery-ledger-boundary.test.ts` drives the built CLI through one session, so the hand-driven run of slice 2a is a test here. Order: prompt, a second prompt with different text, `pre-compact`, `compact-resume`, prompt, an agent's `hippo context rollback plan` with the session id in its environment, then `session-end` with a Claude Code payload. The rows, in id order:

| event_type | block_state | turn_seq |
|---|---|---|
| prompt-submit | sent | 1 |
| prompt-submit | reused | 2 |
| pre-compact | sent | 1 |
| compact-resume | sent | 1 |
| prompt-submit | sent | 3 |
| context | sent | 1 |
| session-end | empty | 1 |

## On/off medians

Driver: `C:/hippo-tmp/z10-slice2b/driver.mjs`, outside the repo, built on the slice 2a driver. Per call, 20 runs with the delivery ledger on and 20 off, in two scratch projects with identical stores (one pin, three facts). The on and off arms run back to back, and the order flips every step. Each run uses a fresh session id, so no run is a duplicate. The time is wall-clock milliseconds of the spawned CLI process, node start-up included. `context` runs `hippo context postgres migration rollback`, and every run printed a block. `session-end` gets a Claude Code payload and runs with a preload that points `process.execPath` at a missing file, so no detached worker runs on the store between timed calls. Each ledger-on project ended with 20 `context` rows, all linked to a trace, and 20 `session-end` rows. The ledger-off projects held none.

Two runs, node v24.13.0, times in ms. The first ran on the uncommitted tree before the fix, the second at `a08b39e7`. The fix does not touch either timed path: every timed `context` call returned rows.

| Call | Run | Median on | Median off | Min on / off | Max on / off | On minus off (median) |
|---|---|---|---|---|---|---|
| `context` | 1 | 558 | 515 | 230 / 226 | 1652 / 1231 | +42.5 |
| `context` | 2 | 593 | 543 | 337 / 283 | 1449 / 1528 | +50.6 |
| `session-end` | 1 | 546 | 526 | 228 / 208 | 1702 / 2144 | +20.4 |
| `session-end` | 2 | 613 | 761 | 302 / 286 | 1411 / 2051 | -148.1 |

Two other hippo sessions were running on the machine. The spread inside one arm (208 to 2144 ms) is far larger than any difference, and `session-end` changed sign between runs. `context` was slower with the ledger on in both runs, by about 45 ms; its row writes candidate rows as well. Two runs of 20 at this noise level cannot tell a cost of that size from none. This slice sets no latency bound.

## Not done

- No full-suite run here. CI runs it on the pull request.
- No latency bound and no quiet-machine run. No in-process timing of the two writes.
- An empty-result `context` row links no trace id. That needs the store port's `finishRecall` to answer the id, a port change outside this slice.
- Tool-failure rows need a schema column and a tool-call duplicate key. Turn-end rows, the Codex wrapper's session end, the server context surfaces and `hippo recall` write no row.
- A sub-agent's `hippo context` counts in its parent session's numbers, and a resumed session can end twice under one id. A missing row is a gap, never evidence that a session did not end or that no context call ran.
