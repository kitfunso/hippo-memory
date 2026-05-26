# J3.2 auto-injection of reference-class baserate on recall — Plan v2

Status: Round 2 (round 1 plan-eng-critic returned fail score 72; 4 must-fixes applied: audit-op count drift in Files table, non-existent lockstep test reference, double-audit predict_baserate pollution via new emitAudit flag, actor pass-through contract)
Episode: 01KSJHJHQPDCMGYT2FBBGH5FWD
Roadmap reference: `ROADMAP-RESEARCH.md` Track J 'next' items (post-J3 follow-up)
Branch: `feat/j32-autoinject-baserate` off master at `e85569d`

## Problem

J3 (PR #73, v1.13.0) ships the `computePredictionBaserate` helper + `hippo predict baserate <class>` CLI + `GET /v1/predictions/stats` + MCP `hippo_predict_baserate`. The cognitive value — Lovallo-Kahneman inside-vs-outside-view correction — only fires if the calling agent **remembers** to invoke the tool when making a forward-looking claim. The discoverability gap is the failure mode the J3 v1 plan flagged as "agent self-discovers when to use the tool".

J3.2 closes the loop: when a recall query contains a forward-prediction phrase (`will take ~3 days`, `ship by Friday`, `ETA in 2 weeks`), the recall surface auto-resolves the closest matching prediction class via token overlap, computes its base rate, and surfaces it inline so the agent sees its track record at the moment of forecasting, not 30 turns later.

## Framing (from brainstorm + grill)

Picked **hybrid regex-gate then token-overlap class lookup** (Candidate C of 5 considered). Grill's strongest objection: regex brittleness causes low recall or false positives. Mitigations:

- High-precision **low-recall** regex set (~8 patterns). Better to fire on 20% of real forward-claims than 80% with 40% noise.
- **Silent on no-class-match.** Detected phrase + zero overlapping class tokens → return nothing, never guess. (No false hints.)
- **Telemetry counter** via `recall_autodebias_hint_no_class_match` audit op so iteration 2 has signal for whether embeddings are worth adding.
- **Token-overlap class resolution** (sub-1ms): SELECT DISTINCT class_tag indexed via `idx_predictions_tenant_class`; intersect lower-cased non-stop-word query tokens against split class tokens; require ≥1 overlap AND **strictly greater than 2nd-best score**. On tie → silent (no hint, but emit `recall_autodebias_hint_tiebreak` audit for telemetry). Picking alphabetically on ties would show the agent the wrong class half the time when query is genuinely ambiguous between two related classes ("migration-effort" vs "migration-risk" with query "migration will take 3 days").
- **`HIPPO_AUTODEBIAS=off|regex` env knob.** Default `regex`; `off` is a clean disable.
- **Additive optional field** `planningFallacyHint?: PlanningFallacyHint` on `RecallResult`. Existing renderers ignore unknown fields. No breaking change.
- **Compute-once from queryText, attach to both pipelines.** Sidesteps the C5 per-pipeline-recompute trap because the hint is a pure function of (queryText, tenantId, predictions table state). All three values are pipeline-invariant — unlike C5's suppressionSummary which described per-pipeline filter activity.

## Field shape (PlanningFallacyHint)

```typescript
export interface PlanningFallacyHint {
  classTag: string;
  baserateSummary: string;           // PredictionBaserate.summary verbatim
  source: 'j3.2-auto';               // Discriminator vs hypothetical future manual override
  detectedPhrase: string;            // The regex match snippet — lets the agent see WHY the hint appeared
  nClosed: number;
  meanRatio: number | null;          // Null only when all estimate_value=0 (excluded from ratio per J3 helper)
}
```

Reasoning for `detectedPhrase` inclusion: agent can self-correct if detection misfires (e.g. "I wasn't actually predicting; ignore the hint"). For UI consumers, also enables a "hide hint" affordance keyed to the phrase.

## In scope

1. **NEW module `src/forward-claim-detector.ts`.** Pure-function regex list + tokenize-and-overlap class matcher. No DB. No state. Zero dependencies beyond stdlib.
2. **`computePlanningFallacyHint(hippoRoot, tenantId, queryText, opts?)`** orchestrator in `src/predictions.ts` (next to `computePredictionBaserate`). Detects, resolves class, calls `computePredictionBaserate`, returns `PlanningFallacyHint | null`. Emits `recall_autodebias_hint` audit on success; emits `recall_autodebias_hint_no_class_match` audit when forward-claim detected but no class resolves (telemetry).
3. **`api.recall` integration.** Populates `RecallResult.planningFallacyHint` when config != 'off' AND query matches AND class resolves AND nClosed > 0. No-op when conditions fail.
4. **MCP `hippo_recall` handler.** Reads `apiResult.planningFallacyHint` (single source — NOT recomputed; the C5 per-pipeline rule does NOT apply because the hint is queryText-derived, not memory-list-derived) and prepends a `## Planning fallacy hint` text block to the response.
5. **HTTP `/v1/recall` response.** Auto-serializes `planningFallacyHint` field (already part of `RecallResult`).
6. **CLI `hippo recall`.** Renders one-line block under memories when hint present: `Planning fallacy hint (class: X): <summary> (detected: "<phrase>")`.
7. **THREE new audit ops** `recall_autodebias_hint` (fires when hint returned) + `recall_autodebias_hint_no_class_match` (telemetry: forward-claim detected, no class resolves) + `recall_autodebias_hint_tiebreak` (telemetry: forward-claim detected, multiple classes tie at best score, silent to caller) lockstep across `src/audit.ts` AuditOp union + `src/cli.ts` VALID_AUDIT_OPS + `src/server.ts` VALID_AUDIT_OPS (v1.11.5 CRIT A institutional rule, verified across 3 sites in pre-plan audit step 2).
8. **`HIPPO_AUTODEBIAS` env knob.** `off | regex` (default `regex` when unset). `embedding` is **reserved** for a future plan, not implemented — invalid values fall back to `regex` with a one-time warn log.
9. **Python SDK lockstep.** `PlanningFallacyHint` Pydantic model (snake_case → camelCase via `_Base` alias_generator) + optional `planning_fallacy_hint: PlanningFallacyHint | None = None` on `RecallResult`. Export from `__init__.py`.
10. **Tests:** detector regex unit (positive + negative + token extraction); class-resolver unit (hit + miss + alphabetical-tiebreak + zero-class-tags); `api.recall` integration (hint populated + AUTODEBIAS=off short-circuit + no-class silent path + no-baserate-data silent path); HTTP route serialization; MCP text block; Python Pydantic round-trip.
11. **Nested manifest version-bump fix (folded in).** `extensions/openclaw-plugin/package.json` + `extensions/openclaw-plugin/openclaw.plugin.json` stuck at `1.12.11` from a pre-existing drift the v1.13.0 ship missed (audit step 3 finding). Bump to ship version. Extend `tests/openclaw-package.test.ts` to assert nested parity — fixes the producer, not the data, per `/dev-framework-rl` 3b item 3.
12. **CHANGELOG entry** under `## Unreleased` (em-dash-free per recurring failure memory).

## Out of scope (explicit, deferred)

- **Embedding-based detector** (J3.3 follow-up). Decision gate: ship regex, observe `recall_autodebias_hint_no_class_match` audit volume for 2 weeks, then decide if embeddings are worth the optional-dep coupling.
- **LLM classifier.** Adds runtime model dependency. Explicitly rejected in brainstorm Candidate B.
- **Per-tenant config.** Env knob is process-wide; per-tenant overrides would need a config table change. Defer until at least one user requests it.
- **30-task estimation eval** (ROADMAP-RESEARCH.md Track J success criterion). Requires a synthetic estimation workload. Mechanism ships now; eval is its own episode.
- **Multi-class hint** (e.g. surface 2-3 candidate classes if multiple match). v1 surfaces single best class. Ties → silent (see Framing).

## Files modified

| File | Change |
|---|---|
| `src/forward-claim-detector.ts` | NEW. `FORWARD_CLAIM_PATTERNS` regex array + `STOP_WORDS` set + `detectForwardClaim(query) → {phrase, classQueryTokens} \| null`. |
| `src/predictions.ts` | Add `interface PlanningFallacyHint` + `function computePlanningFallacyHint(hippoRoot, tenantId, queryText, opts?)`. Internal `resolveClassFromTokens` helper (db SELECT DISTINCT + overlap scoring, alphabetical tiebreak). |
| `src/audit.ts` | Extend `AuditOp` union with ALL THREE: `recall_autodebias_hint` + `recall_autodebias_hint_no_class_match` + `recall_autodebias_hint_tiebreak`. |
| `src/cli.ts` | Add all THREE ops to `VALID_AUDIT_OPS`. cmdRecall renders hint line when present. |
| `src/server.ts` | Add all THREE ops to `VALID_AUDIT_OPS`. /v1/recall response auto-includes hint via RecallResult. |
| `src/predictions.ts` (computePredictionBaserate) | Extend signature with `emitAudit: boolean = true` (4th positional defaulted to preserve existing semantics for direct CLI/HTTP/MCP callers). When `false`, skip the `appendAuditEvent` emit at both n=0 and n>0 paths. |
| `src/api.ts` | Extend `RecallResult` with `planningFallacyHint?: PlanningFallacyHint`. `recall()` calls `computePlanningFallacyHint` near return; attaches when non-null. |
| `src/mcp/server.ts` | `hippo_recall` handler reads `apiResult.planningFallacyHint` (single source); prepends `## Planning fallacy hint` block to text response. |
| `python/src/hippo_memory/models.py` | New `PlanningFallacyHint` Pydantic. Extend `RecallResult` with `planning_fallacy_hint: Optional[PlanningFallacyHint] = None`. |
| `python/src/hippo_memory/__init__.py` | Export `PlanningFallacyHint`. |
| `tests/forward-claim-detector.test.ts` | NEW. ~12 cases. |
| `tests/api-recall-autodebias.test.ts` | NEW. ~10 cases incl. AUTODEBIAS=off, no-class-match silent, no-data silent, tiebreak silent, **actor-attribution end-to-end (MCP / HTTP / CLI all carry correct actor through to inner predict_baserate)**. |
| `tests/http-recall-autodebias.test.ts` | NEW. ~3 cases (hint serialized, absent when no match, auth-gated). |
| `tests/mcp-recall-autodebias.test.ts` | NEW. ~3 cases (text block present / absent / class-tag visible). |
| `tests/audit-ops-autodebias-lockstep.test.ts` | NEW. Parses all three sites (src/audit.ts AuditOp union, src/cli.ts VALID_AUDIT_OPS, src/server.ts VALID_AUDIT_OPS) and asserts ALL THREE new ops (`recall_autodebias_hint`, `recall_autodebias_hint_no_class_match`, `recall_autodebias_hint_tiebreak`) appear in each — the real lockstep safety net (NOT a non-existent `audit-ops-lockstep.test.ts`). |
| `tests/predictions-baserate-emit-audit-flag.test.ts` | NEW. Asserts `computePredictionBaserate(..., emitAudit:false)` skips the audit emit at both n=0 and n>0 paths; default-true preserves existing audit emission. |
| `tests/openclaw-package.test.ts` | EXTEND. Assert nested `extensions/openclaw-plugin/*` parity with root. |
| `python/tests/test_models.py` | Extend with PlanningFallacyHint round-trip + RecallResult parse paths. |
| `CHANGELOG.md` | Entry under `## Unreleased`. |
| `extensions/openclaw-plugin/package.json` | Bump 1.12.11 → next ship version (set at /publish-repo time). |
| `extensions/openclaw-plugin/openclaw.plugin.json` | Same. |

## Implementation tasks (ordered)

**Task 1 — Forward-claim detector module.** Create `src/forward-claim-detector.ts` per shape in this plan. Patterns to ship in v1 (high precision, expandable):

```typescript
const FORWARD_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:will|should|gonna|going\s+to)\s+take\b/i,
  /\bship(?:ping|s)?\s+(?:by|in)\b/i,
  /\bestimate(?:d)?\s+(?:at\s+)?(?:~|≈|about|around)?\s*\d+/i,
  /\b(?:by|in|within)\s+(?:about|around|~)?\s*\d+\s*(?:day|week|month|hour)s?\b/i,
  /\bETA\s*(?:is|:)?\s*\d+/i,
  /\b(?:by|before)\s+next\s+(?:week|month|sprint|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b~\s*\d+\s*(?:day|week|month|hour)s?\b/i,
  /\bshould\s+(?:be|ship|finish|complete|land)\s+(?:by|in|within)\b/i,
];
```

`detectForwardClaim` returns first-match phrase + lower-cased non-stop-word query tokens (>=3 chars, alphanumeric). Stop words: `the a an and or but for to in on at of by with my your our their its it this that these those will should can i we they he she`.

**Task 2 — Class resolver + orchestrator + emitAudit flag on computePredictionBaserate.** In `src/predictions.ts`:

- **`computePredictionBaserate` signature extension** (preserves backward compat for the 3 direct callers): extend to `computePredictionBaserate(hippoRoot, tenantId, classTag, actor='cli', emitAudit=true)`. When `emitAudit === false`, skip the `appendAuditEvent` call at BOTH the n=0 path (currently L447) AND the n>0 path (currently L490). Direct callers (CLI cmdPredict baserate, HTTP /v1/predictions/stats, MCP hippo_predict_baserate) keep their existing audit behavior because they don't pass emitAudit. The orchestrator alone passes `emitAudit:false`.
- `resolveClassFromTokens(hippoRoot, tenantId, queryTokens) → { classTag: string | null, tiebreak: boolean }`: opens db, `SELECT DISTINCT class_tag FROM predictions WHERE tenant_id = ?` (uses `idx_predictions_tenant_class`), scores each class by `class_tag.toLowerCase().split(/[-_\s]+/)` overlap with `queryTokens`. Returns `{ classTag, tiebreak: false }` when best score ≥1 AND strictly greater than 2nd-best. Returns `{ classTag: null, tiebreak: true }` when ≥2 classes tie at the best score (caller emits tiebreak audit + returns null hint). Returns `{ classTag: null, tiebreak: false }` when no class scores ≥1.
- `computePlanningFallacyHint(hippoRoot, tenantId, queryText, opts?)`: orchestrator. Mode default = `process.env.HIPPO_AUTODEBIAS === 'off' ? 'off' : 'regex'` (read inside the function so tests can env-toggle; documented in the function body as the explicit rationale for the per-call read rather than module-load cache). Returns null on (mode === off | empty queryText | no forward-claim detection | resolver returns no class | resolver returns tiebreak | nClosed === 0). On forward-claim-but-no-class: emits `recall_autodebias_hint_no_class_match`. On forward-claim-but-tiebreak: emits `recall_autodebias_hint_tiebreak`. On success: calls **`computePredictionBaserate(hippoRoot, tenantId, classTag, opts.actor ?? 'recall', /*emitAudit=*/false)`** to avoid polluting the predict_baserate audit channel (the orchestrator's own `recall_autodebias_hint` audit carries n_closed + mean_ratio in metadata so no telemetry is lost), then emits `recall_autodebias_hint` audit with `actor=opts.actor ?? 'recall'` and metadata `{ detected_phrase, n_closed, mean_ratio }`. **opts.actor MUST pass through to every nested audit emit** so MCP-originated auto-hints attribute correctly.

**Task 3 — Audit op lockstep.** Add **all three** of `recall_autodebias_hint`, `recall_autodebias_hint_no_class_match`, and `recall_autodebias_hint_tiebreak` to:
- `src/audit.ts` `AuditOp` union (after `predict_baserate`)
- `src/cli.ts` `VALID_AUDIT_OPS` Set
- `src/server.ts` `VALID_AUDIT_OPS` Set

**Lockstep safety net:** Create NEW `tests/audit-ops-autodebias-lockstep.test.ts` that reads all three source files and asserts each of the three new ops appears in each — pattern: `readFileSync(audit.ts).includes("'recall_autodebias_hint'")` etc. for each (op, site) pair. The repo has NO pre-existing generic `audit-ops-lockstep.test.ts` (verified by grep round 1); the new targeted test is the actual mechanism, not a hypothetical generic one. Documented in test file comment: "Locks J3.2's three new ops across the three VALID_AUDIT_OPS sites; modeled on dag-dirty-flag-schema.test.ts:151 which uses the same parse-source pattern."

**Task 4 — api.recall integration.** In `src/api.ts`:
- Extend `RecallResult` interface with `planningFallacyHint?: PlanningFallacyHint;` (after `suppressionSummary?`). Reuse the same "Optional in type for back-compat with test fakes / mocks" docstring pattern.
- Import `computePlanningFallacyHint` + `PlanningFallacyHint` from `./predictions.js`.
- In `recall()`, before the return statement, compute:
  ```typescript
  const planningFallacyHint = computePlanningFallacyHint(
    ctx.hippoRoot,
    ctx.tenantId,
    opts.query,
    { actor: ctx.actor.subject },  // CRITICAL: ctx.actor.subject (api_key:* | mcp | cli | connector:* per Actor type) threads through computePlanningFallacyHint -> computePredictionBaserate(actor=opts.actor) so MCP/HTTP-originated auto-hints get correct attribution
  );
  ```
  Attach via `...(planningFallacyHint ? { planningFallacyHint } : {})` in the returned object (so undefined keeps shape clean for snapshot tests).

**Task 5 — CLI render.** In `src/cli.ts` cmdRecall, after the memories block, when `result.planningFallacyHint` truthy, print one line:
```
Planning fallacy hint (class: <classTag>): <baserateSummary> (detected: "<detectedPhrase>")
```
Use ASCII colon/parens. No em dashes. No box-drawing characters.

**Task 6 — HTTP serializer.** No code change in `src/server.ts` — `/v1/recall` already returns `JSON.stringify(recallResult)` so the optional field rides along. Verify via new test `tests/http-recall-autodebias.test.ts` that the wire JSON has the camelCase shape and is absent when no hint.

**Task 7 — MCP handler.** In `src/mcp/server.ts` case `hippo_recall`:
- Read `apiResult.planningFallacyHint` (NOT recomputed; queryText-derived means pipeline-invariant).
- When truthy, prepend a block to the response BEFORE the formatted memories:
  ```
  ## Planning fallacy hint
  Class: <classTag>
  <baserateSummary>
  (detected: "<detectedPhrase>")
  
  ---
  ```

**Task 8 — Python SDK.** In `python/src/hippo_memory/models.py`:
```python
class PlanningFallacyHint(_Base):
    class_tag: str
    baserate_summary: str
    source: Literal["j3.2-auto"]
    detected_phrase: str
    n_closed: int
    mean_ratio: float | None = None

class RecallResult(_Base):
    # existing fields ...
    planning_fallacy_hint: PlanningFallacyHint | None = None
```
Export `PlanningFallacyHint` from `__init__.py`.

**Task 9 — Tests.**

`tests/forward-claim-detector.test.ts` (~12 cases):
- Positive: `"this will take ~3 days"`, `"should ship by Friday"`, `"estimate 5 days"`, `"ETA: 10 days"`, `"by next Monday"`, `"in ~2 weeks"`, `"should finish by Tuesday"`, `"will take 1 hour"`
- Negative: `"tell me about auth"`, `"by friday"` (no "next"), `"what should I do?"`, `""`
- Token extraction: stop-words removed, short tokens (<3 chars) dropped, pure-numeric dropped

`tests/api-recall-autodebias.test.ts` (~8 cases):
- Setup helper: seed 3 closed predictions in class `"migration-effort"` (estimate 2, actual 4) × 3 → meanRatio = 2.0
- Hint populated for `recall("the migration-effort will take 3 days")` (positive path)
- Hint **absent** for `recall("show me auth code")` (no forward claim)
- Hint **absent** for `recall("will take 3 days")` (forward claim but no overlapping class)
- Hint **absent** for `recall("foo will take 3 days")` when only open (un-closed) predictions exist in class
- `HIPPO_AUTODEBIAS=off` → undefined even with matching query + closed data
- Empty query → undefined
- Cross-tenant scoping: tenant-b query → no hint from tenant-a predictions
- Audit log shows `recall_autodebias_hint` row when hint returned; `recall_autodebias_hint_no_class_match` when phrase matched but no class scored ≥1; `recall_autodebias_hint_tiebreak` when phrase matched and ≥2 classes tied at best score (silent to caller, surfaces in audit only)

`tests/http-recall-autodebias.test.ts` (~3 cases): wire JSON shape, absent-when-no-match, bearer-auth path.

`tests/mcp-recall-autodebias.test.ts` (~3 cases): text block present, absent, class-tag visible in text.

`tests/openclaw-package.test.ts` EXTEND: add `it('keeps nested extension manifests aligned with root')` asserting nested `extensions/openclaw-plugin/package.json` + nested `openclaw.plugin.json` versions equal root `pkg.version`. Add code comment: "Covers the two known nested manifests as of v1.13.x. If new nested manifests are added under a different path, extend this test or convert to a glob-based check across all *.plugin.json / **/package.json with name='hippo-memory'." This is the "fix the producer not the data" pattern — prevents the drift recurrence the v1.13.0 ship missed.

`python/tests/test_models.py` extend: PlanningFallacyHint round-trip; RecallResult with hint roundtrips; RecallResult without hint parses planning_fallacy_hint as None.

**Task 10 — CHANGELOG.** **CHANGELOG.md currently has no `## Unreleased` section** (head -3 confirms it goes from `# Changelog` straight to `## 1.13.0 (2026-05-26)`). Create the `## Unreleased` heading immediately below the `# Changelog` line. Then add:

```markdown
### Added
- **J3.2 auto-injection of planning-fallacy hints on recall.** When a recall query contains a forward-prediction phrase ("will take ~3 days", "ship by Friday", "ETA in 2 weeks"), hippo automatically resolves the closest matching prediction class via token overlap and surfaces its base-rate stats on the new `planningFallacyHint` field of `RecallResult`. CLI, HTTP, and MCP all carry the hint. Tunable via `HIPPO_AUTODEBIAS=off|regex` (default `regex`). Silent on ambiguous class match (multiple classes tie at best overlap score). Three new audit ops: `recall_autodebias_hint` (fires when hint returned), `recall_autodebias_hint_no_class_match` (telemetry: forward-claim detected, no class scored), `recall_autodebias_hint_tiebreak` (telemetry: forward-claim detected, multiple classes tied). Builds on the J3 prediction substrate shipped in v1.13.0.

### Fixed
- **Nested openclaw plugin manifests now match root version.** `extensions/openclaw-plugin/package.json` + `extensions/openclaw-plugin/openclaw.plugin.json` were stuck at 1.12.11 from a pre-v1.13.0 drift the prior ship missed. `tests/openclaw-package.test.ts` extended to assert nested parity so the drift cannot recur silently.
```

## Latency budget

- Detector regex: 8 patterns × O(L) in query length. Typical 50-char query: ~50 microseconds.
- Class resolver: 1 `SELECT DISTINCT class_tag WHERE tenant_id` (indexed) + small overlap scan + a fresh `openHippoDb` handle (no prepared-statement reuse across calls). ~200-300 microseconds per call for typical tenant with <50 class tags (revised from initial 100us claim — the openHippoDb open/close cycle dominates).
- `computePredictionBaserate` (only when class matched): existing helper, ~500 microseconds for typical N<100 closed predictions per class.

Hot-path cost when NO forward-claim match: ~50 microseconds (regex gate only, no DB touch).
Hot-path cost when match + class + baserate: ~750-850 microseconds.

Both well under the 50ms budget. No need for caching at v1 scale.

## Acceptance criteria

1. All TypeScript tests green (existing ~1955 + new ~30 ≈ 1985, including new audit-ops-autodebias-lockstep + predictions-baserate-emit-audit-flag).
2. All Python tests green (existing 26 + ~3 new ≈ 29).
3. `HIPPO_AUTODEBIAS=off` cleanly disables (verified by integration test).
4. Audit log shows `recall_autodebias_hint` rows ONLY when hint was returned to caller (verified by audit row count assertion in test). **AND** `predict_baserate` audit rows are NOT emitted as a side effect of auto-hint (verified by predictions-baserate-emit-audit-flag.test.ts asserting `emitAudit:false` path emits zero predict_baserate rows at n=0 and n>0).
5. **Actor attribution: MCP-originated recall with auto-hint writes audit row with actor='mcp' (not 'cli'); HTTP-originated with actor='api_key:<id>'; CLI-originated with actor='cli'.** Asserted in api-recall-autodebias.test.ts.
6. No regression in existing recall tests (snapshot, contract, fresh-tail, scope, suppression-summary).
7. Python SDK round-trips PlanningFallacyHint via Pydantic with snake_case ↔ camelCase.
8. `tests/openclaw-package.test.ts` extended; nested manifests assert root parity.
9. CHANGELOG.md has `## Unreleased` section created above the `## 1.13.0` block, with the J3.2 entry em-dash-free (grep `—` returns 0 in the new entry).
10. Pre-existing 5 critic gate chain passes: plan-eng, code-review, independent-review, codex-review, ship-readiness.

## Open questions

None — all settled in brainstorm + grill + this plan.
