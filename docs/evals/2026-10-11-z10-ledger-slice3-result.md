# Z10 delivery ledger slice 3: tool-failure rows and one store hash per store, result

**Date:** 2026-10-11  
**Scope:** engineering scope from the [Z10 draft](./2026-09-30-z10-ledger-prereg.md), "Slice 3: engineering scope (settled)" and Amendment 4, registered at `25d388bf` before any slice 3 run; the rebases left that file byte for byte the same (now `62966162`). No task or efficacy claim.  
**Verdict:** every fixture, control, mutant, I4, the live payload check and CI pass; the overhead check has had only void runs on a loaded machine, so the exit stays open until a run that is not void passes.  
**Status:** the delivery ledger stays off by default behind `deliveryLedger.enabled`.

## What was built

- **Migration v55** (`src/db/migrations/v55.ts`): `delivery_events.tool_use_id` (TEXT), `failure_id` (INTEGER) and the partial unique index `idx_delivery_events_tool_call` on (tenant, session, `tool_use_id`) over numbered rows. Behind `tableExists`, no backfill, no `min_compatible_binary` change.
- **The row.** `hippo capture-error` starts a `tool-failure` recorder only when the ledger store is the store the failure is logged in (`startToolFailureRecorder`, `src/api/prompt-hook.ts`). `captureToolFailure` reports the new `failure_log` id, or null when the log write threw, through `onLogged`, and the flush runs in a `finally` inside the same `runHookWithStores` callback (`src/cli/session-hooks.ts`), so the hook still opens the store once. `recordFailure` now returns the row id.
- **Duplicates.** A `tool-failure` row with a `tool_use_id` is a duplicate of the numbered row with the same tenant, session and id; with none it is never a duplicate (`findDuplicateToolFailure`, `src/store/recall-trace.ts`). The id is trimmed and cut to 128 characters.
- **Version 4.** `DELIVERY_LEDGER_VERSION` is 4, and `startDeliveryRecorder` (`src/api/prompt-hook.ts`) hashes `realpathOrResolve(root)` for every row.
- **Reader** (`scripts/z10-reconstruct.mjs`, not shipped): a per-row hash rule (version 4 by resolved root, 3 and below by the two path rules); the verdict's `store_hash` follows the session's last row; `tool-failure` rows are routed out of the delivery groups; `--tool-failures` lists a session's failures; the lesson link is `failure_log.sig_hash = failureHash(memory content)` for a `stored` outcome; class reads carry `origin`.

## What ran

Branch `feat/z10-tool-failure-rows`, PR #797, on master `b5b08d72`: prereg `62966162`, writer `267c7448`, reader and fixtures `404d8c1e`, review fixes `4db50a30`, docs `dcb11db4`. The runs below were on the earlier ids of the same commits (`c90bcc3e`, `68f12c6f`, `36d0158e`) before the rebase onto #795, unless they say otherwise. Node 24.13.0, Windows 11.

- `npm run test:delivery-ledger` at X2's commit: 13 files, 257 tests, all pass; 20 of them in `tests/delivery-ledger-tool-failure.test.ts` (TF1 to TF8, TF9a, TF9b, TF10, N-TF1 to N-TF5, I4 on the TF1, TF2 and TF3 payloads, one command-line case). Writer tests M1 and W1 to W4 are in `tests/migration-v55.test.ts`, `tests/delivery-ledger-writer.test.ts`, `tests/delivery-ledger-recorder.test.ts`, `tests/delivery-ledger-hook.test.ts` and `tests/hook-store-open-count.test.ts`.
- After the first rebase onto master `078f6849`: build, `typecheck:tests` and 16 CI check scripts exit 0. The ledger files plus every file that calls the changed functions: 27 files, 446 of 447 pass. The one failure, boundary E2, put two session-end spawns more than 2 s apart on a machine where `cmd /c exit` took 1.6 to 4.9 s; it passed alone. Slice 2a lists this as an accepted gap.
- After the review fixes and the rebase onto #795 (which moved `startDeliveryRecorder` into `src/api/prompt-hook.ts`): build, `typecheck:tests` and all 19 scripts of CI's `checks` job exit 0, `check-layers` among them; `npm run test:delivery-ledger` 12 files, 260 of 260; the hook-runtime, store-open-count, prompt-hook-context and capture-error test files 68 of 68.
- Full `npm test` on CI, PR #797 at `68f12c6f`: 27 of 27 checks green, including the suite on Ubuntu (three shards and three node-floor shards), macOS and Windows. After the review fixes and the rebase, at `dcb11db4`: 27 of 27 green again. Locally it could not finish: other sessions' Z0 vitest runs and a python job held the machine, and 34 to 38 tests in `token-eval-z0-*` and git-heavy files timed out. None of those files touches this code.
- TF1 as registered: prompt recall on, prompt 2 selected the stored lesson; candidate pool `prompt-recall`, stage `final`, outcome `emitted`; class `application-unknown`, turn 2, `origin` the TF1 row.

### Mutants

Script `C:/hippo-tmp/z10tf/mutate.mjs`, outside the repo; one exact edit per mutant, rebuilt when in `src/`, restored after. Baseline 257 tests, 0 failed.

| Mutant | Cases failed |
|---|---|
| duplicate branch removed | 4 |
| 2000 ms window instead of `tool_use_id` | 11 |
| `failure_id` not set | 11 |
| blank `tool_use_id` kept | 3 |
| version left at 3 | 5 |
| store hash as given | 5 |
| reader routing removed | 6 |
| reader version rule inverted | 5 |
| `after_prompt_turn` from the next prompt | 3 |
| every duplicate counted | 1 (TF3) |
| `log-missing` read as `stored` | 1 (N-TF3) |
| lesson set whatever the outcome | 1 (TF3) |
| `origin` always null | 4 |

The review fixes added TF11 to TF13 and a unit case for the same-store guard. Each one was run once with its fix reverted and failed: the flush moved out of the `finally` (TF12), the guard's realpath check deleted (the unit case, run again after the move to `src/api`), and the listing reading only the numbered row (TF13).

## Live payload

Claude Code 2.1.288, `claude -p` with a scratch project's own settings only. Record: `C:/hippo-tmp/z10tf/live-check.md`, outside the repo.

- **Before registration.** A PostToolUseFailure hook saved stdin for a failing `ls`. The payload carried `tool_use_id` and `prompt_id` next to `session_id`, `tool_name`, `error` and `duration_ms` (payload SHA-256 `b9323c3c...`). This is why the prereg keys duplicates on `tool_use_id`.
- **The built hook, after X1.** The same hook ran this branch's `hippo capture-error` against a fresh store with the ledger on. One failing `npm run` gave `failure_log` id 1 (`stored`, sig_hash `17ab393911b64954`) and one `delivery_events` row: version 4, `tool-failure`, `claude-code`, turn 1, no duplicate, the host's `tool_use_id`, `failure_id` 1, and `store_hash` equal to the hash of the store's resolved root. The stored lesson's `failureHash` equals the log row's sig_hash, which is the reader's lesson join. The hook exited 0 with empty stdout.

## Overhead

`node scripts/ledger-overhead.mjs --memories 2000 --runs 200`, checked by its `pass` field against Amendment 1 (tool-failure p50 under 15 ms, p95 under 30 ms, 0 dropped), with the machine-load rule: five timed `cmd /c exit` runs, and a median over 100 ms makes the run void.

- **Run 1, void** (at `68f12c6f`). `cmd /c exit` took 1791, 3771, 1744, 3694 and 3267 ms, median 3267 ms. For the record, `pass` was true: worst tool-failure p50 2.54 ms and p95 5.22 ms, 0 dropped in fresh and steady. Contention mode dropped 2 of 200 tool-failure rows; no bound covers contention. In this run the tool-failure writes were interleaved with the timed turns.
- **Run 2, pending.** The review fixes moved the tool-failure writes into their own loop. A watcher runs the script the first time the median is at or under 100 ms. Through the review the median stayed between 524 and 2104 ms, while other sessions held 76 node processes; total CPU read 13% and the disk was idle, so process start-up, not compute, was slow.

## Review

A code critic (pass, 84, nothing marked must-fix) and codex (`gpt-5.6-sol`, two P2 findings) reviewed the branch at `68f12c6f`. Fixed in `4db50a30` (first written as `36d0158e`):

1. **A stored lesson on a duplicate row was lost** (codex). If two hook processes catch one tool call, the one that stored the lesson can flush second, and its row becomes the duplicate. The listing read only the numbered row. Each entry now reads its whole duplicate group and takes its outcome, `failure_id` and lesson from the group's `stored` row when there is one. Fixture: the race's end state, built with the real hook and writer.
2. **The lesson link could name a later failure's lesson** (critic). If F1's lesson is forgotten and F2 with the same signature stores a new one, F1 matched it. The link now holds only when the failure is the newest `stored` log row with that signature; otherwise it is null with a `lesson-superseded` note.
3. **Class reads dropped the lesson notes** (codex). `origin` was looked up with a throwaway notes list; the notes now reach the class read.
4. **Loss window 2 had no test** (critic). A built-CLI case makes the `failure_log` insert throw and checks the row is still written with `failure_id` null, read as `log-missing`, exit 0.
5. **The log id could be lost after the row committed** (critic). `recordFailure` pruned after its insert, so a failed prune threw away the id of a committed row. It now prunes first.
6. Smaller ones: a unit case for the same-store guard; the writer and recorder cases moved into their owning test files; the exit-reader helper hashes like a version 4 row; bound parameters in the test helpers; the overhead script times tool-failure writes in their own loop, so the turn bounds are measured as in slice 2.

Not changed, with reasons:
- The unique index leaves out `event_type`. It matches the registered index; the decision record notes that a later event type carrying `tool_use_id` would need it in the key.
- `--tool-failures` prints `{ entries, notes }`, not the bare array the plan named, because the lesson and foreign-store notes need a home.
- The prereg's loss window 1 says "one warn line"; the writer logs that failure at error level, as it has since slice 1. The prereg's wording is wrong, and the code is unchanged.

## Deviations

- TF4 fires its two failures one after the other and does not check that they fall in one second. The same-instant case is covered at the writer: W2 writes two distinct ids within one millisecond and gets two numbered rows.
- N-TF1's interleaved row is a routine failure, so no lesson is stored and both sessions hold the same memories; event ids are normalised to turn order to compare two sessions.
- TF9 is split into TF9a (a junction) and TF9b (a `.hippo` that links to the global store).

## Not done

- Storing `prompt_id`; the server failure caller; Codex and OpenCode rows (no failure hook); default-on.
