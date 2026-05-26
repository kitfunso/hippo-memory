# C5 WYSIATI Cutoff Transparency — Plan v3

Status: Draft v3 (plan-eng-critic round 1 must-fixes folded)
Episode: 01KSHTN0RYYSCXCAJCTN5TJJDC
Roadmap reference: `ROADMAP-RESEARCH.md` L219, Track C Pineal Gland, C5 [next]
Branch: `feat/c5-wysiati-recall-transparency` off master at commit 9e31868

## Problem

When `hippo recall --budget N` truncates the candidate set, the cut is silent: the calling agent receives `results[0..limit]` and `total` but no breakdown of WHY the rest were excluded. The agent treats the cutoff as the full picture (Kahneman's "What You See Is All There Is", TFAS ch. 7). Hippo uniquely has the lifecycle metadata to surface *what was excluded and why*; today it discards that information at the API boundary.

## Plan v3 changes (response to plan-eng-critic round 1)

Round 1 verdict was `fail` (score 68) with one CRIT (MCP pipeline divergence), one HIGH (Task 2 scoping), two MEDs (Task 3 cmdRecall mapping, Task 5 Pydantic alias), one LOW (line numbers). Resolutions:

1. **CRIT — MCP user-visible pipeline divergence (option a chosen):** MCP gets its own `RecallSuppressionSummary` computation from the physics/hybrid pipeline at the MCP `hippo_recall` handler. Replaces `apiResult.suppressionSummary` in the user-facing payload with the MCP-pipeline counters. New Task 8c covers it. Hoisted shared helper `buildSuppressionSummary(...)` lets all three pipelines (api.recall, cmdRecall, MCP) populate without duplicating field-construction logic.
2. **HIGH — Task 2 outer-scope declaration:** Task 2 now spells out: declare the 5 mutable counters as `let` in the outer `recall()` scope alongside `rankedOut` / `tokensOut` / `totalOut` so the return at end-of-function reads them.
3. **MED — Task 3 cmdRecall enumeration:** Task 3 now enumerates every cmdRecall drop/filter site and pins each to a specific field. The semantic broadening to `dropped_pre_rank` (renamed from `dropped_by_scope_filter`) covers --outcome / --layer / --filter-conflicts / --as-of / pre-rank --salience-threshold drops cleanly without inventing a 7th field. Reorder sites (--evc-adaptive / --value-aware / --rerank-utility / --reranker / --goal / dlPFC / --salience-reorder portion) are explicitly noted as NOT counted — they change order, not membership.
4. **MED — Task 5 Pydantic alias:** Task 5 now reads "declare snake_case field; rely on `_Base` inherited `alias_generator=to_camel`; do NOT add per-field alias."
5. **LOW — line numbers:** All Tasks now use anchor references (function name + comment context, e.g. "after the JS scope filter `entries = all.filter(...!isPrivateScope...)`") not L-numbers.

## Field shape (v3, 6 fields, renamed one)

```typescript
export interface RecallSuppressionSummary {
  /** Total candidates loaded from the store, before any post-load filter or limit cut.
   * Per-pipeline source:
   * - api.recall: all.length immediately after loadRecallSearchEntries
   * - cmdRecall: entries.length immediately after the initial loadAllEntries / loadSearchEntries
   * - MCP physics/hybrid: count of entries passed to physicsSearch/hybridSearch */
  total_candidates: number;
  /** Candidates dropped by any PRE-rank filter (before scoring/ordering).
   * Per-pipeline source:
   * - api.recall: all.length - entries.length (private-scope JS filter + scope-mismatch defense)
   * - cmdRecall: SUM of drops from --as-of, --include-superseded default (drops superseded), --filter-conflicts (drops superseded), --outcome, --layer, --salience-threshold (when used as a hard drop). All these run BEFORE the final rank.
   * - MCP physics/hybrid: scope-filter drops at the MCP handler before physicsSearch */
  dropped_pre_rank: number;
  /** Candidates loaded but excluded by the final `limit` slice after scoring.
   * Per-pipeline source:
   * - api.recall: entries.length - baseSlice.length
   * - cmdRecall: pre-slice candidate count - final slice count (at the cmdRecall final cut)
   * - MCP physics/hybrid: pre-slice - post-slice at the physics/hybrid limit */
  dropped_by_budget: number;
  /** Substituted DAG-L2 summaries added back to mitigate overflow.
   * Per-pipeline source:
   * - api.recall: substituted.length after the summarizeOverflow block
   * - cmdRecall: same metric if cmdRecall runs the substitution path; else 0
   * - MCP physics/hybrid: 0 (MCP does not run summarizeOverflow today) */
  summary_substitutions_added: number;
  /** Fresh-tail kind='raw' rows prepended.
   * Per-pipeline source:
   * - api.recall: freshRanked.length when freshTailCount > 0; else 0
   * - cmdRecall: same metric when --fresh-tail is set; else 0
   * - MCP physics/hybrid: 0 (MCP does not currently expose fresh-tail) */
  fresh_tail_added: number;
  /** Placeholder for future B4 vlPFC interference-suppression counts.
   * Always 0 in v1.12.13. Populated by future B4-depth or J1-anchoring work that
   * reads from the `interference_suppression` table during recall. The field is
   * surfaced now so consumers can `.suppressed_by_interference > 0` check without
   * waiting for a wire-format bump. */
  suppressed_by_interference: number;
}
```

Add as `suppressionSummary?: RecallSuppressionSummary` on `RecallResult` (optional in the type for back-compat with test fakes; same pattern as `windowSize?` at v1.7.0).

## In scope

1. New TypeScript interface `RecallSuppressionSummary` in src/api.ts near the existing `RecallResult` declaration.
2. New optional `suppressionSummary?` field on `RecallResult`.
3. Shared helper `buildSuppressionSummary(counts: {...}): RecallSuppressionSummary` (also in src/api.ts) so the three pipelines (api.recall, cmdRecall, MCP) produce the same shape without duplicating field-construction.
4. Population of `suppressionSummary` in `api.recall` from its filter pipeline.
5. Population of `suppressionSummary` in CLI `cmdRecall` from its richer filter pipeline.
6. Population of `suppressionSummary` in MCP `hippo_recall` handler from the physics/hybrid pipeline — replacing whatever `apiResult.suppressionSummary` contained before user-facing serialization.
7. CLI `--why` output renders a one-line WYSIATI summary after the result list.
8. Python SDK Pydantic model `RecallSuppressionSummary` + optional field on `RecallResult` model.
9. Python SDK exports updated (`__init__.py`).
10. Integration test for api.recall asserting the breakdown shape.
11. HTTP parity test asserting the wire format includes `suppressionSummary` and pre-v1.12.13 payloads (without the field) still parse on the client side.
12. CLI snapshot test updated to capture the rendered breakdown in `--why` output.
13. Pydantic round-trip test for the new model + back-compat parse of legacy payload.
14. CHANGELOG entry under whatever in-progress release marker the file currently uses (verified in Task 11, not assumed).

## Out of scope (explicit, deferred to follow-up)

- Populating `suppressed_by_interference` with real B4 interference suppression counts — needs B4 depth work to read `interference_suppression` table during recall.
- Splitting `dropped_pre_rank` into per-filter sub-counters (one each for --outcome / --layer / --as-of / etc.) — possible follow-up if consumers want the fine-grain breakdown. v1 ships the aggregate.
- Counter for re-ranking effects (--evc-adaptive / --value-aware / --rerank-utility / --reranker / --goal / dlPFC) — these are reorder operations, not drops. Re-ranking effect is visible via the existing ScoreBreakdown.{preMmrRank, postMmrRank, preRerankRank, postRerankRank} fields; no new top-level counter.
- Counter for --salience-threshold soft-drop portion. Salience can both reorder and drop; v1 plan counts only the hard-drop portion in `dropped_pre_rank`. The soft-rebalance is logged in ScoreBreakdown as today.
- A `dropped_by_other_filters` 7th aggregated field — rejected in favour of the semantic broadening of `dropped_pre_rank`.
- Per-detector trace (which specific memory was dropped by which filter). Out of scope; this is a counts-only surface.
- Opt-out flag (`RecallOpts.includeSuppressionSummary`). Always-on is the v1 choice; ~80-byte cost is dwarfed by results. Future opt-out non-breaking.

## Files modified

| File | Change |
|---|---|
| src/api.ts | New `RecallSuppressionSummary` interface; new `suppressionSummary?` field on `RecallResult`; shared `buildSuppressionSummary(...)` helper; populate in `recall()` at the existing filter sites. |
| src/cli.ts | Populate `suppressionSummary` in `cmdRecall`'s recall-result construction (mapping per Task 3); render in `--why` output (single line, skip zero-count clauses). |
| src/mcp/server.ts | At the `hippo_recall` handler, after the physics/hybrid pipeline runs, build a `RecallSuppressionSummary` from THAT pipeline's filter sites via the shared helper and attach to the user-facing payload (replacing `apiResult.suppressionSummary`). Update tool-description string to note that suppression counts describe the user-visible memory list. |
| python/src/hippo_memory/models.py | New `RecallSuppressionSummary` Pydantic model (6 `int` fields, `Field(default=0)` each); new `suppression_summary: Optional[RecallSuppressionSummary] = None` field on `RecallResult` model. Snake_case fields only; rely on `_Base` inherited `alias_generator=to_camel` for wire format. |
| python/src/hippo_memory/__init__.py | Add `RecallSuppressionSummary` to exports. |
| tests/api-recall-suppression-summary.test.ts | NEW. Real-DB integration test. |
| tests/http-recall-suppression-summary.test.ts | NEW. Real-DB HTTP parity test. |
| tests/mcp-recall-suppression-summary.test.ts | NEW. Real-DB MCP handler test asserting MCP-pipeline counters are returned (not api.recall counters). |
| tests/__snapshots__/cli-context-render-snapshot.test.ts.snap | UPDATE. Capture the new `--why` line. |
| python/tests/test_models.py | NEW Pydantic round-trip + back-compat parse test. |
| CHANGELOG.md | Add entry under in-progress release marker (convention verified in Task 11). |

## Implementation tasks (ordered)

**Task 1 — define the type + shared helper.** In src/api.ts near the existing `RecallResult` declaration, add the `RecallSuppressionSummary` interface (6 fields, JSDoc per the field-shape section above). Add `buildSuppressionSummary(opts: {totalCandidates, droppedPreRank, droppedByBudget, summarySubstitutionsAdded, freshTailAdded, suppressedByInterference}): RecallSuppressionSummary` helper that maps camelCase input to the snake_case-on-wire shape. Add optional `suppressionSummary?: RecallSuppressionSummary` to `RecallResult`.

**Task 2 — populate in `api.recall`.** In src/api.ts `recall()`:
- Declare 5 mutable counters in the OUTER `recall()` scope alongside `rankedOut` / `tokensOut` / `totalOut`: `let totalCandidatesCount = 0; let droppedPreRankCount = 0; let droppedByBudgetCount = 0; let summarySubstitutionsCount = 0; let freshTailCount = 0;` — declared OUTSIDE the try/finally that wraps the substitution + fresh-tail blocks, so the return at end-of-function can read them.
- After `loadRecallSearchEntries(...)`: `totalCandidatesCount = all.length;`
- After the JS scope filter `entries = all.filter((e) => !isPrivateScope(...))`: `droppedPreRankCount = all.length - entries.length;`
- After `baseSlice = entries.slice(0, limit)`: `droppedByBudgetCount = entries.length - baseSlice.length;`
- After the substitution block builds `substituted[]`: `summarySubstitutionsCount = substituted.length;`
- After the fresh-tail block builds `freshRanked[]`: `freshTailCount = freshRanked.length;`
- At the return statement, attach `suppressionSummary: buildSuppressionSummary({totalCandidates: totalCandidatesCount, droppedPreRank: droppedPreRankCount, droppedByBudget: droppedByBudgetCount, summarySubstitutionsAdded: summarySubstitutionsCount, freshTailAdded: freshTailCount, suppressedByInterference: 0})` to the `RecallResult` literal.

**Task 3 — populate in `cmdRecall`.** READ cmdRecall in full before editing (it spans roughly 800-1200 lines in src/cli.ts; the recall handler section). Pipeline mapping (drop sites count, reorder sites do not):

| cmdRecall site | Counter |
|---|---|
| `--as-of` bi-temporal pre-filter drops | `dropped_pre_rank` |
| `--include-superseded` not set (DEFAULT drops superseded) | `dropped_pre_rank` |
| `--filter-conflicts` drops further superseded | `dropped_pre_rank` |
| `--outcome` filter drops | `dropped_pre_rank` |
| `--layer` filter drops | `dropped_pre_rank` |
| `--salience-threshold` hard-drop portion | `dropped_pre_rank` |
| `--evc-adaptive` reorder | NOT counted (reorder, not drop) |
| `--value-aware` reorder | NOT counted |
| `--rerank-utility` reorder | NOT counted |
| `--reranker` reorder | NOT counted |
| `--goal` boost reorder | NOT counted |
| dlPFC goal-stack boost reorder | NOT counted |
| Final limit slice | `dropped_by_budget` |
| Scope-filter drops (pre-load or post-load) | `dropped_pre_rank` |
| Summary substitution (if cmdRecall uses it) | `summary_substitutions_added` |
| Fresh-tail (if cmdRecall uses it) | `fresh_tail_added` |

Implementation pattern: track each filter site's drop count as cmdRecall does its work. Sum into `droppedPreRankCount` at the cmdRecall populate site. Use `buildSuppressionSummary(...)` to construct. Attach to the cmdRecall result before returning to the renderer. Where cmdRecall genuinely does not run a filter (e.g. fresh-tail when `--fresh-tail` is not passed), counter is 0.

**Task 4 — CLI `--why` renderer.** In src/cli.ts find the `--why` renderer (likely a function that prints ScoreBreakdown lines per result). Add a single-line WYSIATI summary AFTER the per-result breakdowns, emitted only when at least one count is non-zero. Format: `WYSIATI: showing <returned>/<total_candidates>; <dropped_by_budget> dropped by limit; <dropped_pre_rank> pre-rank filtered; <summary_substitutions_added> summary substitutions added; <fresh_tail_added> fresh-tail added; <suppressed_by_interference> suppressed by interference.` Skip zero-count clauses to keep the line tight.

**Task 5 — Python SDK Pydantic model.** In python/src/hippo_memory/models.py, add `class RecallSuppressionSummary(_Base): total_candidates: int = 0; dropped_pre_rank: int = 0; dropped_by_budget: int = 0; summary_substitutions_added: int = 0; fresh_tail_added: int = 0; suppressed_by_interference: int = 0` (snake_case only, no per-field `alias=` — `_Base` inherits `alias_generator=to_camel` which serializes the wire format). Add `suppression_summary: Optional[RecallSuppressionSummary] = None` to the `RecallResult` model. Cross-check against existing `RecallResult` model in the file to confirm the convention is exactly as described — the critic's audit showed the model has only 3 fields today (`results`, `total`, `tokens`) and uses `alias_generator=to_camel` on `_Base`.

**Task 6 — Python SDK exports.** In python/src/hippo_memory/__init__.py, add `RecallSuppressionSummary` alongside the other model exports.

**Task 7 — TS integration test.** New `tests/api-recall-suppression-summary.test.ts`. Real DB (tmp dir + initStore). Insert 25 memories. Call `recall({query: "test", limit: 5})`. Assert `suppressionSummary` is defined, `total_candidates >= 25`, `dropped_by_budget >= 20`, `dropped_pre_rank >= 0`, `summary_substitutions_added >= 0`, all fields integer. Edge case: `limit >= entries.length` → `dropped_by_budget === 0`, summary still defined.

**Task 8 — HTTP parity test.** New `tests/http-recall-suppression-summary.test.ts`. Start `hippo serve` in-process, POST `/v1/recall` with same fixture, assert response JSON has `suppressionSummary` key with all 6 counters. Backward-compat sub-test: hand-construct a literal pre-v1.12.13-shaped response (no `suppressionSummary` key), pass through the client's JSON parsing path, assert it deserializes without error and `suppressionSummary` is `undefined`.

**Task 8b — MCP tool schema check.** Read src/mcp/server.ts `hippo_recall` tool definition. If it declares an `outputSchema` or any field enumeration in its response shape, add `suppressionSummary` to that schema. If it's pass-through serialization, no schema change.

**Task 8c — MCP handler integration test.** New `tests/mcp-recall-suppression-summary.test.ts`. Real DB + spin up MCP handler in-process. Call `hippo_recall` tool. Assert the returned payload's `suppressionSummary` reflects the MCP physics/hybrid pipeline counts (NOT the api.recall counts). Specific assertion: the test should insert memories such that api.recall's `total_candidates` would differ from MCP physics/hybrid's `total_candidates`, and confirm MCP returns the LATTER. This is the proof of fix for the round-1 CRIT.

**Task 9 — CLI snapshot update.** Run `npm test -- cli-context-render-snapshot --update` after Tasks 3 + 4. Inspect the diff; commit the snapshot update only if the new line matches the WYSIATI format spec.

**Task 10 — Python Pydantic test.** New test in python/tests/test_models.py. Round-trip: build `RecallResult(results=[], total=0, tokens=0, suppression_summary=RecallSuppressionSummary(total_candidates=10, dropped_by_budget=5))` → `model_dump(by_alias=True)` → re-parse. Assert no fields lost. Back-compat: parse a dict WITHOUT `suppressionSummary` key → assert `result.suppression_summary is None`, no errors.

**Task 11 — CHANGELOG.** READ existing CHANGELOG.md FIRST to identify the in-progress release marker convention (hippo uses `## [vX.Y.Z] - YYYY-MM-DD` for shipped releases; in-progress entries land under whatever section the most recent unshipped commit established). Add a single bullet describing the new field, shape, per-pipeline divergence note, and back-compat. **Em-dash check before commit:** pipe the entry through `grep -c "—"` (literal U+2014); replace any em dashes with `--` or commas before commit (recurring failure mode, memory `feedback_commit_em_dash_recurring`).

## Test commitments

- `npm test` full suite green (1900+ tests).
- `cd python && pytest` green.
- New TS integration test asserts api.recall breakdown shape.
- New HTTP test asserts wire-format + back-compat.
- New MCP test asserts MCP-pipeline counters (round-1 CRIT proof of fix).
- Python Pydantic round-trip + back-compat.

## Success criteria (mirrored from roadmap L221)

1. Integration test asserts the breakdown appears whenever `total_candidates > budget` — Task 7 covers.
2. Paired tier-1 micro-eval shows agent decision quality non-regression with the breakdown injected — VERIFY stage runs `npm test` as the non-regression bar; full A/B deferred to follow-up if tier-1 harness isn't a one-line invocation. Honest-best-effort.
3. CLI + HTTP /v1/recall + MCP hippo_recall surface parity — Task 2 (api.recall), Task 3 (cmdRecall), Task 8c (MCP) all populate the same RecallSuppressionSummary shape via the shared `buildSuppressionSummary` helper. Counters reflect per-pipeline filter activity (honest divergence, documented in JSDoc + CHANGELOG); shape is identical across all three surfaces.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| cmdRecall pipeline filter sites may not all have clean accounting points | Task 3 enumerates the sites with mapping; implementer reads cmdRecall in full first, surfaces gaps as TODO comments rather than silent 0. |
| MCP physics/hybrid pipeline filter accounting may also be awkward | Task 8c includes the structural test that proves MCP returns MCP-pipeline counters (not api.recall counters); if accounting is awkward, the test forces an honest implementation. |
| Pydantic v2 alias mapping convention varies in models.py | Task 5 explicitly says rely on inherited `alias_generator=to_camel`; cross-check by reading existing `RecallResult` model first (critic audit confirmed convention). |
| Snapshot test update creates noise if `--why` output is heavily used elsewhere | Task 9 instructs to inspect diff before committing snapshot. |
| `suppressed_by_interference` always 0 surfaces as confusing noise | Plan accepts this. CLI renderer skips zero-count clauses; HTTP returns 0 for consistency (clients can `.suppressed_by_interference > 0` check). |
| Pydantic SDK consumers may break if they strict-validate response shape | New field is `Optional` with default `None`. Existing payloads parse unchanged. Forward-compat by design. |

## Verification approach (verify stage)

1. `npm run build && npm test` — full suite must be green.
2. `cd python && pytest` — Python SDK suite green.
3. Manual smoke: `hippo recall "test query" --budget 5 --why` against a populated `.hippo/` should show the WYSIATI line when `total_candidates > 5`.
4. Manual smoke: `hippo serve` then `curl -X POST http://127.0.0.1:6789/v1/recall -H "Authorization: Bearer ..." -d '{"query":"test","limit":5}'` should return `suppressionSummary` in JSON.
5. Paired tier-1 micro-eval (if cheap to run; otherwise skip and note "decision-quality A/B deferred to follow-up").

## Effort

1-2d single engineer. Surgical addition, no schema migration, no contract break. Adds one TS interface + one shared helper + 3 pipeline-specific populate sites + Pydantic model + 3 new test files + 1 snapshot update + CHANGELOG line.

## Status: Draft v3 (plan-eng-critic round 1 must-fixes folded). Awaiting plan-eng-critic round 2.
