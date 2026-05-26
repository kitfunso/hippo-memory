# E2 prediction first-class object — Plan v3

Status: Draft v3 (plan-eng-critic round 1 must-fixes folded)
Episode: 01KSJ516M0JDGEVFAFV3WFTAVK
Roadmap reference: `ROADMAP-RESEARCH.md` L314, E2 first-class objects table, `prediction` row (Track J pre-req)
Branch: `feat/e2-prediction-object` off master at commit `08c3b94`

## Problem

J3 (reference-class / planning-fallacy detector) needs a structured store of ex-ante claims to compare against ex-post outcomes. Today hippo has no first-class way to record "I predict X by Y" and later close it with "actual was Z." This episode ships the prediction object so J3 can read base-rate stats from real data in a follow-up episode.

## Plan v3 changes (response to plan-eng-critic round 1, score 58)

Round 1 found 1 CRIT + 3 HIGH + 5 MED + 1 LOW. Resolutions:

1. **CRIT — ON DELETE RESTRICT FK breaks 4 deletion paths.** Resolved by making the predictions table CANONICAL (all fields including `claim_text` live in the table; memory side is a recall/inspect mirror, not the source of truth). FK `memory_id` is now nullable with `ON DELETE SET NULL` — memory deletion gracefully orphans the prediction without breaking `deleteEntry`, `batchWriteAndDelete`, `resolveConflict`, or `archiveRawMemory`. Cross-tenant safety preserved via INSERT trigger (single-col FK + nullable + SET NULL is incompatible with composite FK; trigger achieves the same "bad rows unrepresentable" outcome).
2. **HIGH — invented insertMemoryRowInTx helper.** Resolved by using the existing `writeEntry(hippoRoot, entry, { afterWrite: (db, memoryId) => ... })` pattern from `src/store.ts:1184`, which already runs inside the memory write's SAVEPOINT 'write_entry'. supersede uses it at api.ts:1486; Slack/GitHub connectors use it. No new helper invented.
3. **HIGH — composite FK requirement.** Single-col FK + INSERT trigger achieves the cross-tenant safety goal. Documented as a v1 trade-off (SQLite's ON DELETE SET NULL is incompatible with composite FK where one side is NOT NULL).
4. **HIGH — closePrediction memory mutation unspecified.** Resolved by DROPPING the memory tag-append from v1 entirely. The predictions table is canonical; the memory side stays a static record. v1.12.15 follow-up can add memory-side closure tags if needed for recall surface.
5. **MED — closure_state semantics non-deterministic.** Collapsed to 3 states: `open` / `closed` / `closed-unknown`. J3 computes accuracy (clean vs regressed) from `(estimate_value, actual_value)` at query time. More flexible per-class thresholds.
6. **MED — HTTP status query.** Aligned with full 3-state enum.
7. **MED — MCP scope contradiction.** Resolved by committing explicitly: agent only READS predictions via HTTP/SDK in v1. MCP entirely deferred. Justification: J3 base-rate query is a READ operation; predictions are typically user-issued reflections. If session-side MCP becomes needed (e.g. agent-issued claim logging), v1.12.15+ follow-up.
8. **MED — DB CHECK constraint on closure_state.** Added to CREATE TABLE.
9. **MED — SAVEPOINT atomicity test injection.** Specified: use the writeEntry afterWrite hook to inject a throwing predicate, verify no predictions row landed AND the memory write rolled back.
10. **LOW — memory decay during open prediction.** Documented limitation: predictions table survives memory decay independently. Open predictions are queryable via `hippo predict list`, not via free-text `hippo recall` on a decayed memory. v1.12.15 could pin the backing memory's half-life to "extended" until close (mirror handoff pattern).

## Field shape (v3, predictions table is canonical)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | row id |
| `memory_id` | TEXT NULLABLE | FK to `memories.id`, ON DELETE SET NULL. Recall mirror, not canonical. |
| `tenant_id` | TEXT NOT NULL | tenant scoping; INSERT trigger enforces tenant_id matches the referenced memory when `memory_id IS NOT NULL` |
| `class_tag` | TEXT NOT NULL | "migration-effort", "rollout-risk", etc. — the J3 base-rate cohort |
| `claim_text` | TEXT NOT NULL | the human-readable prediction; canonical, not just a mirror of memory.content |
| `estimate_value` | REAL NULLABLE | numeric estimate; null for categorical predictions |
| `estimate_unit` | TEXT NULLABLE | "days", "percent", "count"; null for categorical |
| `target_date` | TEXT NULLABLE | ISO date the prediction is for; null for open-ended |
| `actual_value` | REAL NULLABLE | populated on close (null when closure_state = 'closed-unknown') |
| `closure_state` | TEXT NOT NULL DEFAULT 'open' | DB CHECK: `IN ('open', 'closed', 'closed-unknown')` |
| `closed_at` | TEXT NULLABLE | ISO timestamp |
| `closure_note` | TEXT NULLABLE | optional context |
| `created_at` | TEXT NOT NULL | ISO timestamp |

Indexes:
- `idx_predictions_tenant_class` on `(tenant_id, class_tag, closure_state)` for J3 base-rate scan
- `idx_predictions_memory` on `(memory_id)` for the back-reference lookup

INSERT trigger (cross-tenant safety):

```sql
CREATE TRIGGER predictions_tenant_match BEFORE INSERT ON predictions
WHEN NEW.memory_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
    THEN RAISE(ABORT, 'predictions.tenant_id must match memories.tenant_id for the referenced memory')
  END;
END;
```

## In scope

1. Schema migration v29: CREATE TABLE predictions + 2 indexes + INSERT trigger.
2. New module `src/predictions.ts` with store helpers (savePrediction, closePrediction, loadPredictionById, loadPredictionsByClass, loadOpenPredictions, rowToPrediction). savePrediction uses `writeEntry(hippoRoot, entry, { afterWrite })` so the memory write and the predictions INSERT are atomic inside the SAVEPOINT 'write_entry' that writeEntryDbOnly opens. closePrediction is a single UPDATE on predictions (no memory mutation in v1).
3. CLI `cmdPredict` subcommand: create / close / list / show.
4. HTTP `/v1/predictions` routes: POST create, GET list (status filter accepts open|closed|closed-unknown|all), GET :id, POST :id/close.
5. Two new audit ops: `predict_create`, `predict_close`. LOCKSTEP update at `src/cli.ts` `VALID_AUDIT_OPS` AND `src/server.ts` `VALID_AUDIT_OPS` AND `src/audit.ts` `AuditOp` union per v1.11.5 CRIT A institutional rule.
6. Python SDK: new `Prediction` + `PredictionCreated` + `PredictionClosed` Pydantic models; async + sync methods on `Hippo` / `HippoSync`; exports in `__init__.py`.
7. `VALID_CLOSURE_STATES: ReadonlySet<string>` in `src/predictions.ts`. CLI parser + HTTP body validator reject anything not in the set.
8. Tests: store-level (real DB, SAVEPOINT atomicity via afterWrite hook injection, cross-tenant trigger, ON DELETE SET NULL behavior) + CLI (direct cmdPredict calls, no subprocess) + HTTP parity + Python SDK Pydantic round-trip + back-compat parse.
9. CHANGELOG entry under `## Unreleased` (em-dash-free).

## Out of scope (explicit, deferred)

- MCP `hippo_predict` / `hippo_predict_list` / `hippo_predict_close` tools — committed explicitly to v1.12.15+. v1 agent path is HTTP/SDK only.
- `hippo predict stats --class X` — this IS J3 (the reference-class detector). Next episode.
- Memory tag-append on closePrediction — predictions table is canonical; memory-side closure tags are nice-to-have, not required for J3.
- Composite FK to `memories(id, tenant_id)` — incompatible with the chosen ON DELETE SET NULL semantics; INSERT trigger achieves cross-tenant safety. v1.12.15+ could revisit if needed.
- Memory half-life pinning for open predictions — open predictions queryable via `hippo predict list`. v1.12.15+ could mirror the handoff "extended-half-life" pattern.
- Categorical-estimate base-rates — J3 handles numeric only in v1; categorical predictions stored with null `estimate_value`.
- Prediction supersession — predictions close, don't supersede.

## Files modified

| File | Change |
|---|---|
| `src/db.ts` | Add migration v29: CREATE TABLE predictions + 2 indexes + INSERT trigger predictions_tenant_match. Bump `CURRENT_SCHEMA_VERSION` from 28 to 29. |
| `src/predictions.ts` | NEW module. PredictionRow interface, Prediction domain type, save/close/load helpers, rowToPrediction, VALID_CLOSURE_STATES constant. |
| `src/store.ts` | Re-export predictions helpers via the existing store barrel pattern. NO new in-tx helper; savePrediction uses existing writeEntry/writeEntryDbOnly afterWrite hook. |
| `src/cli.ts` | New `cmdPredict` handler + `case 'predict':` dispatch + usage text. Add `predict_create` + `predict_close` to `VALID_AUDIT_OPS` set. |
| `src/server.ts` | New POST /v1/predictions, GET /v1/predictions, GET /v1/predictions/:id, POST /v1/predictions/:id/close handlers (Bearer-auth, tenant-scoped, status filter validated against VALID_CLOSURE_STATES). Add `predict_create` + `predict_close` to `VALID_AUDIT_OPS` set (LOCKSTEP with cli.ts). |
| `src/audit.ts` | Extend `AuditOp` union with `predict_create` + `predict_close`. |
| `python/src/hippo_memory/models.py` | New `Prediction` Pydantic model with snake_case fields. Inherited `alias_generator=to_camel` handles wire camelCase. |
| `python/src/hippo_memory/client.py` | New `Hippo.predict()` / `predict_close()` / `list_predictions()` / `get_prediction()` async methods. |
| `python/src/hippo_memory/sync_client.py` | Sync mirrors. |
| `python/src/hippo_memory/__init__.py` | Export new types. |
| `tests/predictions-store.test.ts` | NEW. SAVEPOINT atomicity via afterWrite hook injection, cross-tenant INSERT trigger, ON DELETE SET NULL behavior, tenant scoping, schema-migration test. |
| `tests/cli-predict.test.ts` | NEW. Direct cmdPredict calls with captured stdout. Audit-op acceptance. |
| `tests/http-predictions.test.ts` | NEW. HTTP endpoint parity, status filter validation, Bearer auth, cross-tenant isolation. |
| `python/tests/test_predictions.py` | NEW. Pydantic round-trip + back-compat parse + SDK method shape test. |
| `CHANGELOG.md` | Entry under `## Unreleased`. |

## Implementation tasks (ordered)

**Task 1 — Schema migration v29.** In `src/db.ts` migrations array, add a v29 entry. CREATE TABLE IF NOT EXISTS predictions(...) with the field shape + CHECK constraint on closure_state. Create the 2 indexes. Create the INSERT trigger predictions_tenant_match. Bump `CURRENT_SCHEMA_VERSION` from 28 to 29.

**Task 2 — New module `src/predictions.ts`.** Domain types + store helpers + VALID_CLOSURE_STATES constant.

- `interface Prediction { id, memoryId?, tenantId, classTag, claimText, estimateValue?, estimateUnit?, targetDate?, actualValue?, closureState, closedAt?, closureNote?, createdAt }`
- `const VALID_CLOSURE_STATES = new Set(['open', 'closed', 'closed-unknown'])`
- `savePrediction(hippoRoot, tenantId, opts: SavePredictionOpts): Prediction` — creates the memory via `createMemory(claimText, { tags: ['prediction', classTag], layer: Layer.Semantic, confidence: 'observed', source: 'prediction', kind: 'distilled' })` and calls `writeEntry(hippoRoot, mem, { afterWrite: (db, memoryId) => { db.prepare(...INSERT predictions...).run(...) } })`. The afterWrite runs inside writeEntryDbOnly's SAVEPOINT 'write_entry'. The predictions row INSERT returns the row id; the Prediction domain object is built from the inserted values. Emit `predict_create` audit op with metadata `{ prediction_id, class_tag, has_estimate, target_date }` (no claim_text in metadata — GDPR-light).
- `closePrediction(hippoRoot, tenantId, id, opts: { actualValue?, closureState, closureNote? }): Prediction` — opens db, BEGIN IMMEDIATE, UPDATE predictions SET actual_value = ?, closure_state = ?, closed_at = ?, closure_note = ? WHERE id = ? AND tenant_id = ?. Reject closure_state not in VALID_CLOSURE_STATES. Re-load the row to return. Emit `predict_close` audit op with metadata `{ prediction_id, closure_state, has_actual }`. NO memory mutation in v1.
- `loadPredictionById(hippoRoot, tenantId, id): Prediction | null`
- `loadPredictionsByClass(hippoRoot, tenantId, classTag, opts?: { closureState?, limit? }): Prediction[]`
- `loadOpenPredictions(hippoRoot, tenantId, opts?: { classTag?, limit? }): Prediction[]`
- `rowToPrediction(row: PredictionRow): Prediction`

**Task 3 — CLI `cmdPredict`.** New async function in `src/cli.ts`. Sub-commands routed by `args[0]`:
- `hippo predict "<claim>" --class <c> [--estimate <v>] [--unit <u>] [--target <YYYY-MM-DD>]` — create
- `hippo predict close <id> --state <closed|closed-unknown> [--actual <v>] [--note "..."]` — close; reject if state not in VALID_CLOSURE_STATES
- `hippo predict list [--class X] [--status open|closed|closed-unknown|all] [--limit N]` — list
- `hippo predict show <id>` — show
- Add `case 'predict':` to the main switch.
- Add usage line under the help text.
- Audit-emit via `emitCliAudit(hippoRoot, 'predict_create' | 'predict_close', ...)`.

**Task 4 — Audit ops lockstep.** Add `'predict_create'` and `'predict_close'` to:
- `VALID_AUDIT_OPS` set at `src/cli.ts` (~L4832)
- `VALID_AUDIT_OPS` set at `src/server.ts` (~L71)
- `AuditOp` union type at `src/audit.ts`

Per v1.11.5 CRIT A institutional rule (pre-plan audit step 385 confirmed both sites + the union exist).

Audit metadata shapes:
- `predict_create`: `{ prediction_id: string, class_tag: string, has_estimate: boolean, target_date: string | null }`
- `predict_close`: `{ prediction_id: string, closure_state: string, has_actual: boolean }`

No PII / claim_text in metadata (GDPR-light, parallels the v0.31 recall audit pattern).

**Task 5 — HTTP `/v1/predictions` routes.** In `src/server.ts`:
- `POST /v1/predictions` — body `{ claim, classTag, estimate?, unit?, targetDate? }` → calls savePrediction → returns `{ prediction: Prediction }`.
- `GET /v1/predictions?class=X&status=open|closed|closed-unknown|all&limit=N` — calls loadPredictionsByClass or loadOpenPredictions (depending on status filter); validates `status` against `VALID_CLOSURE_STATES ∪ {'all'}`; returns `{ predictions: Prediction[] }`.
- `GET /v1/predictions/:id` — calls loadPredictionById → returns `{ prediction: Prediction }` or 404.
- `POST /v1/predictions/:id/close` — body `{ actual?, state, note? }` → calls closePrediction → returns `{ prediction: Prediction }`.
- All routes Bearer-auth + tenant-scoped via existing middleware. DoS cap on `claim` length (4096 chars) + `closureNote` length (2048 chars) per existing v1.11.4 pattern.

**Task 6 — Python SDK.** In `python/src/hippo_memory/models.py`:
- `class Prediction(_Base)` with snake_case fields matching the TS interface. All optional fields default to `None`.
- Default `closure_state="open"`.

In `python/src/hippo_memory/client.py` (`Hippo`):
- `async def predict(self, claim, class_tag, estimate=None, unit=None, target_date=None) -> Prediction`
- `async def predict_close(self, prediction_id, state, actual=None, note=None) -> Prediction`
- `async def list_predictions(self, class_tag=None, status=None, limit=None) -> list[Prediction]`
- `async def get_prediction(self, prediction_id) -> Prediction`

Mirror on `HippoSync`. Export from `__init__.py`.

**Task 7 — Tests.**

- `tests/predictions-store.test.ts`: 10 cases minimum.
  1. savePrediction creates memory AND row (verify both with explicit SELECT).
  2. SAVEPOINT atomicity: inject a throwing afterWrite via spy, assert no predictions row landed AND no memories row landed.
  3. closePrediction updates row + emits audit.
  4. Cross-tenant trigger: attempt INSERT predictions with tenant_id != memory's tenant_id → RAISE ABORT.
  5. ON DELETE SET NULL: forget the memory, then SELECT predictions row, verify memory_id is now NULL but the prediction row still exists with all other fields.
  6. loadPredictionsByClass filters correctly.
  7. loadOpenPredictions excludes closed.
  8. VALID_CLOSURE_STATES rejection: pass `'invalid'` to closePrediction, expect throw.
  9. tenant scoping: cross-tenant load returns empty.
  10. Schema migration v29 on pre-v29 DB: open with old schema, run migration, verify predictions table + trigger + indexes exist.
- `tests/cli-predict.test.ts`: direct cmdPredict calls (NOT subprocess). 6 cases: create / close / list / show / status filter / VALID_CLOSURE_STATES rejection at CLI parser layer.
- `tests/http-predictions.test.ts`: real DB + in-process server. 8 cases: all 4 routes + Bearer auth + cross-tenant isolation + status filter validation + DoS cap on claim length.
- `python/tests/test_predictions.py`: Pydantic round-trip + back-compat (server response missing optional fields parses cleanly) + 4 SDK methods exist.

**Task 8 — CHANGELOG.** Under `## Unreleased`. Em-dash-free per recurring failure memory `feedback_commit_em_dash_recurring`. Pre-commit grep ritual: `grep -c "—" CHANGELOG.md` to verify 0 em dashes in added lines before commit.

## Test commitments

- `npm run build` clean.
- `npm test` full suite green (1920+ pass; the 1 pre-existing `tests/openclaw-package.test.ts` failure stays out of scope).
- `cd python && pytest` green.
- New TS tests assert SAVEPOINT atomicity via afterWrite injection (the canonical test pattern from tests/connectors-slack-ingest.test.ts), cross-tenant trigger, ON DELETE SET NULL.

## Success criteria

1. `hippo predict "migration will take 2 days" --class migration-effort --estimate 2 --unit days --target 2026-06-15` creates BOTH a memory (visible in `hippo recall`) AND a predictions table row (visible in `hippo predict list`).
2. `hippo predict close <id> --state closed --actual 5 --note "had to backfill"` updates the predictions row only (memory unchanged in v1).
3. `hippo predict list --class migration-effort --status closed` returns the closed predictions in that class.
4. HTTP `POST /v1/predictions` and `POST /v1/predictions/:id/close` round-trip parity with CLI.
5. Python SDK: `await hippo.predict("X", class_tag="Y", estimate=2)` and `await hippo.predict_close(id, state="closed", actual=5)` work end-to-end.
6. `audit_log` table records `predict_create` and `predict_close` events under the right tenant + actor with the specified metadata shapes.
7. SAVEPOINT rollback: a forced failure in afterWrite leaves NO row in predictions AND NO new memory row.
8. Cross-tenant INSERT trigger: a malformed INSERT with mismatched tenant_id RAISES ABORT.
9. ON DELETE SET NULL: forgetting a memory leaves the prediction row intact with `memory_id = NULL`.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| writeEntry afterWrite hook semantics differ from expected | Task 2 directs implementer to read store.ts:1153-1230 + verify by reading the supersede call site at api.ts:1486. The hook contract is documented; do NOT invent. |
| SQLite trigger BEFORE INSERT compatibility | SQLite supports BEFORE INSERT triggers with RAISE(ABORT). Test #4 verifies the trigger fires. |
| ON DELETE SET NULL silently orphans predictions during sleep-cycle | Documented as the chosen semantics. J3 readers must handle NULL memory_id. List/get helpers return the prediction regardless of memory presence. |
| Trigger overhead on memory INSERTs | Trigger only fires on predictions INSERTs (not memories). No memory-write hot-path impact. |
| Free-text class_tag drift | v1 accepts any string. Future typed-enum follow-up if class drift becomes a problem. |
| Open predictions surviving past 30d memory decay | Documented in out-of-scope. v1 callers use `hippo predict list` for open predictions; `hippo recall` is best-effort. |

## Verification approach (verify stage)

1. `npm run build && npm test` full suite green.
2. `cd python && pytest` green.
3. Manual smoke: `hippo predict "test prediction" --class smoke-test --estimate 1` then `hippo predict list --class smoke-test`.
4. Manual smoke: `hippo serve` + curl round-trip + Bearer auth verification.
5. Audit-log check: `hippo audit --limit 5` shows `predict_create` and `predict_close` rows.
6. SAVEPOINT atomicity proof: trigger a test that forces afterWrite to throw, verify no orphan rows in either memories or predictions table.

## Effort

~6d single engineer (revised from v1's 6d after grill + critic-r1 found the scope was actually tighter than originally drafted; predictions-canonical means less memory-side wiring; MCP deferral removes ~1d). Single PR off master at `08c3b94`, no schema-migration drift (additive table, no breaking change), no version bump in this episode.

## Status: Draft v3 (plan-eng-critic round 1 must-fixes folded). Awaiting plan-eng-critic round 2.
