# AT5: negative-retrieval assertions in the micro-eval

Episode 01M1SCJTR3TS64XPTD7H6Q63V4. ROADMAP.md:1095-1098 (AT5, `[next, small]`). Batch 01M1S1M74R8RW419AK3W17FB7X (version bump to 1.38.2 happens at the batch gate).

## Problem

The tier-1 micro-eval (`benchmarks/micro/`) asserts what recall must return, and only incidentally what it must not. AT5's finding: hippo has boundary negatives (cross-tenant tests) but no content negatives in the eval suites for superseded, suppressed or rejected values. Today:

- `fixtures/vlpfc_gate.json` asserts the superseded value is absent only under `--include-superseded --filter-conflicts`. Both of its queries pass `--include-superseded`, so the default recall filter (src/search.ts, `includeSuperseded` gates at 377 and 883, filters at 438 and 1122) has no fixture at all. If that filter regressed, every fixture would still pass.
- `fixtures/path_boost.json` forgets remember 0 and asserts its token absent, but as a side effect of a path-boost ranking test with `top_k: 1`.
- No fixture covers AT1 rejected values (PR #142 shipped `hippo reject <id> --reason`, `rejections`, `unreject`). ROADMAP AT5 names this paired case explicitly, gated on AT1 shipping. It has.

## What already exists

- `benchmarks/micro/run.py` already evaluates `must_not_contain_any` (run.py:530-533, `leaked`), and 8 of 12 fixtures use it. Nothing changes in scoring.
- Actions `supersede`, `outcomes`, `recall`, `promote`, `forget` run after remembers in declared order via an if/elif chain (run.py:322-456). Each action resolves its target through `remember_ids[idx]` and runs from `remember_cwds[idx]`. There are three places an action type is listed: the elif chain, the module docstring "Action types" list (run.py:50-91), and README.md "Actions" (README.md:63-73; that list already lacks `recall`, `promote` and `forget`, pre-existing).
- Each fixture store is created with `hippo init --no-learn --no-hooks --no-schedule` (run.py:285), so only declared remembers exist. Fixtures use invented marker tokens so substring assertions cannot collide.
- `hippo reject <id> --reason "<why>"` (src/cli.ts:3897 `cmdReject`, src/reject-flow.ts:68 `rejectValue`) removes the matching live row and tombstones the content digest. A later `hippo remember` of the same text exits 1 with `Error: Memory value refused: matches a rejected value (digest ..., reason: ...)` (verified against the built CLI in a `HIPPO_HOME` sandbox during discover).
- What "suppressed" means in hippo today: the default superseded filter; the vlPFC `--filter-conflicts` gate (src/cli.ts:1287-1330: drops `superseded_by` rows, 0.3x score on `conflicts_with` peers present in the result set); `forget` hard-delete; the AT1 reject tombstone. The B4 depth `interference_suppression` table and `--show-suppressed` are not built (src/api.ts:631). `conflicts_with` is only populated by sleep's `detectConflicts` -> `replaceDetectedConflicts` (src/store.ts:2874), so the 0.3x down-rank has no deterministic CLI setup and stays out of this item.

## Changes

1. **`benchmarks/micro/run.py`: a `reject` action.**

   ```json
   {"type": "reject", "remember_index": 3, "reason": "wrong retry policy", "reattempt": true}
   ```

   Runs `hippo reject <id> --reason <reason>` from `remember_cwds[idx]` and `check_returncode()`s it. `reason` is required by the CLI, so a missing or empty `reason` raises `ValueError` naming the fixture (same shape as the other action validation errors). Uncaptured id raises `RuntimeError` like `forget`. When `reattempt` is true (default false), the runner re-runs `hippo remember <original text>` from the same cwd and requires exit code 1 with `rejected value` in stderr; any other outcome raises `RuntimeError` naming the fixture and quoting stdout/stderr, because a successful re-remember means the tombstone did not hold and the fixture's later negative assertion would be testing the wrong thing. To have the original text, the remember loop keeps a `remember_texts` list parallel to `remember_ids` and `remember_cwds`.

   The docstring "Action types" list and the README "Actions" list each gain a `reject` entry (the three sites named above). No other runner behaviour changes.

2. **`benchmarks/micro/fixtures/negative_retrieval.json`**, mechanic `negative-retrieval`. Six remembers with invented tokens, three actions, five queries:

   | # | remember | role |
   |---|---|---|
   | 0 | render-tier cache eviction is `zorblat` LRU with a two hour ttl | superseded |
   | 1 | team retro notes live under the `drumlin` wiki page | neutral filler |
   | 2 | scheduler leader lease held by the `vexmoor` node for ninety seconds | forgotten |
   | 3 | payment retries use `quillfang` linear backoff with fifty attempts | rejected |
   | 4 | payment retries use `marlowe` exponential backoff capped at five attempts | positive sibling for 3 |
   | 5 | scheduler leader lease heartbeat is fifteen seconds on the `ostrel` node | positive sibling for 2 |

   Actions, in order: `supersede` 0 with new content `render-tier cache eviction is kestrelarc LFU with a six hour ttl` (same vocabulary as row 0 so it competes for query 1); `forget` 2; `reject` 3 with `reattempt: true`.

   Queries (all `top_k: 3`):

   | q | cli_args | must_contain_any | must_not_contain_any | what it pins |
   |---|---|---|---|---|
   | cache eviction policy for the render tier | none | kestrelarc | zorblat | default recall filters superseded rows |
   | cache eviction policy for the render tier | `--include-superseded` | zorblat | none | positive control: the old row is stored, so the absence above is the filter, not a missing row |
   | scheduler leader lease | none | ostrel | vexmoor | forgotten row does not resurface |
   | payment retries backoff | none | marlowe | quillfang | rejected row is gone |
   | payment retries backoff | `--include-superseded` | marlowe | quillfang | the tombstone is a removal, not a soft flag that a superseded override could reveal |

   Every `must_contain_any` token belongs to a row that shares the query's vocabulary with the negative one, so each query has a live competitor and the negative is load-bearing rather than "nothing matched".

3. **ROADMAP.md AT5 header** goes from `[next, small]` to `[shipped 2026-09-05, micro-eval]` with one status line naming the fixture and that the rejected paired case is included. The LongMemEval half of the item's opening sentence is not touched by this fixture and the status line says so.

4. **CHANGELOG.md**: one bullet under `## 1.38.2 - unreleased` (the heading is added by this PR if the batch gate has not merged one yet; the gate resolves the shared heading).

## Explicit non-changes

- No `src/` change. This item asserts existing behaviour.
- vlpfc_gate.json keeps the under-gate suppression case; it is not copied into the new fixture.
- The `conflicts_with` 0.3x down-rank is not asserted (needs a sleep-detected conflict; see "What already exists").
- LongMemEval harness gets no must-not assertions here; AT5's success line names the micro-eval fixtures.
- README.md's pre-existing omission of `recall`, `promote` and `forget` from its Actions list is left as is (mentioned, not fixed).
- The micro-eval is not wired into CI (no workflow or package script references `benchmarks/micro`); that stays as is.

## Risks

- **A fixture that can only pass.** Mitigated in verify by three red runs: the new fixture against the pre-change runner (`ValueError: unknown action type 'reject'`), a mutation that skips the superseded filter at both layers, `dist/cli.js` (the pre-rank drop, src/cli.ts:1037) and `dist/search.js` (query 1 must leak `zorblat`, the others stay green; verify found that mutating search.js alone does not bite because the CLI drops superseded rows before search runs), and a `dist/rejection.js` mutation that returns early from `checkRejectionGuard` (the `reattempt` step must raise). The fixture is green on the real build before and after.
- **Token collisions.** All markers are invented words absent from the other remembers; `--no-learn` keeps the store to the declared rows.
- **Ranking ties.** `top_k: 3` over at most six live rows; the positive sibling shares two or three query terms with the query, the filler shares none.

## Verification

- `python benchmarks/micro/run.py --filter negative` green (5/5), then the full micro-eval to prove no fixture regressed from the runner change. Verify result: 8 of 13 fixtures pass; the 5 failures (dlpfc-goals, ofc-utility, pineal-salience, reranker-cross-encoder, vmpfc-value) fail identically with the c130d7a runner over the c130d7a fixtures against the same build (overall 0.764 there), so they predate this change and are not touched here.
- Red runs listed under Risks, with output captured in the verify manifest.
- `python -m py_compile benchmarks/micro/run.py`; `npx tsc --noEmit` unchanged (no src change); `git diff` grep for em dashes and secrets.
