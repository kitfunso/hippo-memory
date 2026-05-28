# E2 decision first-class object — Plan v1

Status: Draft v1 (not yet engineering-reviewed — fresh-eyes scrutiny expected)
Episode: 01KSQQRJ2JFVG7R19N0KE0HNPA (dev-framework-rl)
Roadmap reference: E2 first-class objects (sibling of the shipped `prediction` object, docs/plans/2026-05-26-e2-prediction-object.md)
Mirror template: `src/predictions.ts` + db.ts migration v29 (shipped v0.31)
Branch: `feat/e2-decision-object` off master at `27f5ae6`

## Problem

`hippo decide` exists today (cli.ts:6849) but a decision is stored ONLY as a
tagged memory: `createMemory(content, { tags: ['decision'], source: 'decision',
confidence: 'verified' })` with `half_life_days = DECISION_HALF_LIFE_DAYS` (90,
memory.ts:123). Because it is just a memory, an in-force decision **decays on a
90-day half-life even while it is still in force** — recall can lose a decision
that was never reversed. There is no structured way to list active decisions, no
audit trail for decision mutations, and supersession is approximated by halving
the old memory's half-life and tagging it `superseded`.

This episode promotes `decide` to a first-class object by mirroring the v0.31
prediction pattern exactly: a canonical `decisions` table that is the source of
truth (so decay no longer loses a live decision), lifecycle ops, CLI + HTTP +
Python SDK wiring, and audit ops in the 3-site lockstep. The existing memory
mirror is kept for recall surfaces but is no longer authoritative.

## Brainstorm carry-forward (step 450) — each concern addressed or deferred

The brainstorm chose framing A* ("mirror predictions MECHANICS, not fields") and
grilled it. Carry-forward items and their resolution in this plan:

1. **Do NOT copy prediction fields** (estimate/actual/closure don't map). →
   ADDRESSED. Decision-specific schema: `decision_text, context, status,
   superseded_by, superseded_at, closed_at, created_at, tenant_id, memory_id`.
2. **Keep the memory mirror for recall BUT make the table source-of-truth** so
   recall decay no longer loses a still-in-force decision. → ADDRESSED. Table is
   canonical; `decide list --status active` is authoritative; recall is
   best-effort (memory still decays, by design — exactly the predictions model).
3. **NO backfill** of existing decision-tagged memories — additive-only, stays
   out of the live-data ASK-FIRST gate. → ADDRESSED. Out of scope; flagged as a
   follow-up. Pre-episode rows simply have no `decisions` row.
4. **Preserve backward-compat for `hippo decide --supersedes`.** → ADDRESSED.
   `--supersedes <memory-id>` keeps its exact legacy behavior (weaken the prior
   decision memory) AND, if that memory has an active `decisions` row, supersedes
   the row too. See "Backward-compat contract" below.
5. **Add `decision_supersede` audit op alongside `decision_create`.** → ADDRESSED,
   plus `decision_close` for the `close` lifecycle op (three mutations, three
   audit ops — mirrors predictions auditing both of its mutations).

Grill's strongest objection: *"decisions may not need first-class status if they
are only recalled, not queried."* Answer: the concrete 90-day decay bug means
recall already loses live decisions; roadmap E2 lists `decision` as a first-class
object; and `decide list --status active` is a genuine structured-query use that
free-text recall cannot serve. The objection does not survive the decay bug.

## Key design decision — 3-state status (refines the brainstorm's 2-state sketch)

The brainstorm sketched `status in [active, superseded]`. The problem's lifecycle
list is **decide / supersede / list / get / close**, and a 2-state model cannot
represent "closed without a replacement" (a decision retired because its whole
subsystem was removed, with no successor). This plan therefore uses a **3-state
enum `active | superseded | closed`**, which:

- supports the full lifecycle list (close = retire with no successor),
- mirrors predictions' own 3-state `open | closed | closed-unknown` pattern, and
- keeps `decide list --status active` clean (retired decisions drop out).

`superseded` always carries a `superseded_by` (the successor); `closed` never
does. This is a deliberate, documented refinement of the brainstorm carry-forward,
not a drift from it.

## Field shape (decisions table is canonical)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | table row id (the first-class id) |
| `memory_id` | TEXT NULLABLE | FK `memories(id)` ON DELETE SET NULL. Recall mirror, not canonical. |
| `tenant_id` | TEXT NOT NULL | tenant scoping; INSERT+UPDATE triggers enforce match vs the referenced memory when `memory_id IS NOT NULL` |
| `decision_text` | TEXT NOT NULL | the decision itself (canonical, not just a mirror of memory.content) |
| `context` | TEXT NULLABLE | the "why"; stored structured here, also concatenated into the memory mirror for backward-compat recall |
| `status` | TEXT NOT NULL DEFAULT 'active' | DB CHECK: `IN ('active','superseded','closed')` |
| `superseded_by` | INTEGER NULLABLE | self-FK `decisions(id)` ON DELETE SET NULL; set only when `status='superseded'` |
| `superseded_at` | TEXT NULLABLE | ISO ts, set on supersede |
| `closed_at` | TEXT NULLABLE | ISO ts, set on close |
| `created_at` | TEXT NOT NULL | ISO ts |

Indexes (mirror predictions):
- `idx_decisions_tenant_status` on `(tenant_id, status)` for the `list --status active` scan.
- `idx_decisions_memory` on `(memory_id) WHERE memory_id IS NOT NULL` for the back-reference lookup.

Triggers (mirror predictions' insert+update tenant-match, db.ts:1025-1047):
- `trg_decisions_tenant_match_insert` / `_update` — `decisions.tenant_id` must
  match `memories.tenant_id` for the referenced memory when `memory_id IS NOT NULL`.
- `trg_decisions_supersede_tenant_match_update` — when `superseded_by IS NOT NULL`,
  the referenced successor decision must share the tenant (makes cross-tenant
  supersession unrepresentable at the schema level, per the multi-tenant
  composite-FK probation memory: schema-level beats handler-level). Fires on
  UPDATE (the only path that sets `superseded_by`).

## Backward-compat contract (the load-bearing risk)

The existing `decide --supersedes <id>` takes a **memory id** and weakens that
memory (cli.ts:6864-6875). New first-class subcommands (`decide get/close <id>`)
take a **decision table id** (integer), exactly like predictions
(`predict show/close <id>`). This memory-id-vs-table-id split is the one
ergonomic wrinkle; it is the price of not breaking existing `--supersedes`
callers, and it is documented in CLI help.

`decide --supersedes <memory-id>` after promotion does, in this order (reordered
vs the legacy code so the canonical table is written first — a grill-surfaced
improvement):
1. **Validate**: read the memory; if missing → error (legacy behavior). Look up an
   **active** `decisions` row with that `memory_id` for the tenant; if found,
   capture its table id.
2. **Atomic table mutation**: call `saveDecision` with `supersedesDecisionId` =
   that table id (when found). The new decision row is INSERTed and the old row is
   UPDATEd → `superseded` in the SAME afterWrite SAVEPOINT — both commit or neither.
3. **Legacy memory-weaken (best-effort, LAST)**: halve the old memory's half-life,
   `confidence='stale'`, add the `superseded` tag, writeEntry.

Reordering puts the canonical table mutation first: if step 3 fails, the table is
fully consistent (new created, old superseded) and only the cosmetic memory-weaken
is skipped — strictly better than the legacy order (which weakened the memory
first and could leave it stale with no successor). If the memory has no active
`decisions` row (legacy pre-episode memory), step 2 creates a fresh decision with
no supersession and step 3 still weakens the old memory — exact old behavior.
Memory-weakening is a CLI backward-compat behavior, NOT first-class; HTTP/SDK
supersede never weakens a memory.

## Module API — `src/decisions.ts` (mirrors `src/predictions.ts`)

```ts
export type DecisionStatus = 'active' | 'superseded' | 'closed';
export const VALID_DECISION_STATES: ReadonlySet<DecisionStatus>;

export interface Decision {
  id: number;
  memoryId: string | null;
  tenantId: string;
  decisionText: string;
  context: string | null;
  status: DecisionStatus;
  supersededBy: number | null;
  supersededAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface SaveDecisionOpts {
  decisionText: string;
  context?: string;
  supersedesDecisionId?: number;  // table id of the active decision to supersede
  extraTags?: string[];           // CLI passes path tags; HTTP/SDK pass none
}

// create memory mirror (tags ['decision', ...extraTags], source 'decision',
// confidence 'verified', half_life DECISION_HALF_LIFE_DAYS) + decisions row,
// atomically inside writeEntry's SAVEPOINT 'write_entry'; emits decision_create.
// If supersedesDecisionId: UPDATE that row -> superseded (superseded_by = new id,
// superseded_at = now) in the SAME SAVEPOINT; emits decision_supersede. The UPDATE
// is a CAS guard: WHERE id=? AND tenant_id=? AND status='active'; on changes===0
// THROW a conflict error (mirrors closePrediction predictions.ts:263-276) so a
// concurrent/duplicate supersede of an already-superseded row aborts the whole
// SAVEPOINT (new row included) instead of silently creating an orphan successor.
export function saveDecision(hippoRoot, tenantId, opts: SaveDecisionOpts, actor?): Decision;

// CLI-testable backward-compat helper: resolve a --supersedes <memory-id> to the
// active decisions table id for that memory (or null for a legacy pre-episode
// memory with no row). Extracted so the CLI's memory-id path is unit-tested at
// the store layer (no cmdDecide export / subprocess needed).
export function resolveActiveDecisionIdByMemory(hippoRoot, tenantId, memoryId: string): number | null;

// BEGIN IMMEDIATE; UPDATE status='closed', closed_at=now WHERE id AND tenant AND
// status='active'; 0-changes -> distinguish not-found vs not-active (mirror
// closePrediction guard); emits decision_close.
export function closeDecision(hippoRoot, tenantId, id: number, actor?): Decision;

export function loadDecisionById(hippoRoot, tenantId, id): Decision | null;
export function loadDecisions(hippoRoot, tenantId, opts?: { status?: DecisionStatus; limit?: number }): Decision[];
export function loadActiveDecisions(hippoRoot, tenantId, opts?: { limit?: number }): Decision[];
```

Imports mirror predictions.ts: `openHippoDb/closeHippoDb` (db.js), `writeEntry/
assertTenantId` (store.js), `createMemory/Layer/MemoryKind` (memory.js),
`appendAuditEvent` (audit.js), `DECISION_HALF_LIFE_DAYS` (memory.js).

Memory mirror content: `context ? \`${decisionText}\n\nContext: ${context}\` :
decisionText` (preserves the existing recall surface verbatim). The table stores
`decision_text` and `context` separately.

## CLI — extend `cmdDecide` (`case 'decide'`, cli.ts:6849)

Route on `args[0]` (mirror cmdPredict):
- `hippo decide "<text>" [--context "<why>"] [--supersedes <memory-id>]` — create
  (the existing signature, now also writing the table row + audit, + table
  supersession when `--supersedes` resolves to an active row).
- `hippo decide list [--status active|superseded|closed|all] [--limit N]` — list;
  output shows both the table id and the memory id so `--supersedes` is usable.
- `hippo decide get <id>` — show one by table id.
- `hippo decide close <id>` — close by table id.
- Edge: a decision whose literal text is `list`/`get`/`close` is misrouted to the
  subcommand — same accepted limitation as predictions; documented in help.
- Audit emits flow through `saveDecision`/`closeDecision` (single source, no
  call-site drift), tenant via `resolveTenantId({})` (as the existing handler).

Help text (cli.ts:6133-6135) updated for the new subcommands.

## Audit ops — 3-site lockstep (the institutional rule)

Add `'decision_create'`, `'decision_supersede'`, `'decision_close'` to ALL three
(v1.11.5 CRIT A rule; tests/audit-ops-*-lockstep.test.ts enforce it):
- `AuditOp` union — src/audit.ts (L130-154)
- `VALID_AUDIT_OPS` set — src/cli.ts (L5261)
- `VALID_AUDIT_OPS` set — src/server.ts (L103)

GDPR-light metadata (no decision_text), mirroring predictions:
- `decision_create`: `{ decision_id, has_context: boolean }`
- `decision_supersede`: `{ decision_id (the superseded/old id), superseded_by (new id) }`
- `decision_close`: `{ decision_id }`

## HTTP — `/v1/decisions` routes (`src/server.ts`, mirror `/v1/predictions`)

- `POST /v1/decisions` — body `{ text, context?, supersedesDecisionId? }` → `saveDecision` → `{ decision }`.
- `GET /v1/decisions?status=active|superseded|closed|all&limit=N` — validate `status` against `VALID_DECISION_STATES ∪ {'all'}`; `loadDecisions`/`loadActiveDecisions` → `{ decisions }`.
- `GET /v1/decisions/:id` — `loadDecisionById` → `{ decision }` or 404.
- `POST /v1/decisions/:id/supersede` — body `{ text, context? }` → `saveDecision(..., supersedesDecisionId=:id)` → returns the NEW decision (table-id supersede path; no memory weakening — HTTP surface is new, no backward-compat constraint).
- `POST /v1/decisions/:id/close` — `closeDecision` → `{ decision }`.
- All Bearer-auth + tenant-scoped via existing middleware. DoS caps: `text` 4096, `context` 4096 (existing v1.11.4 pattern).

## Python SDK (`python/src/hippo_memory/`)

- `models.py`: `class Decision(_Base)` snake_case fields matching the TS interface; `status` default `"active"`; optional fields default `None`.
- `client.py` (`Hippo`, async): `decide(text, context=None)`, `supersede_decision(decision_id, text, context=None)`, `close_decision(decision_id)`, `list_decisions(status=None, limit=None)`, `get_decision(decision_id)`.
- `sync_client.py` (`HippoSync`): sync mirrors.
- `__init__.py`: export `Decision`.

## In scope

1. Schema migration v30 (CREATE TABLE decisions + 2 indexes + 3 triggers); bump `CURRENT_SCHEMA_VERSION` 29 → 30 (db.ts:26).
2. `src/decisions.ts` module (types, VALID_DECISION_STATES, save/close/load helpers, rowToDecision).
3. CLI `cmdDecide` extension (create now first-class + list/get/close subcommands), help text.
4. 3 audit ops in the 3-site lockstep.
5. HTTP `/v1/decisions` routes.
6. Python SDK models + async/sync methods + exports.
7. Tests: store (real DB), CLI (direct calls), HTTP (in-process), Python SDK.
8. CHANGELOG entry under `## Unreleased`, em-dash-free.

## Out of scope (explicit, deferred)

- Backfill of existing decision-tagged memories into `decisions` rows (additive-only; live-data op deferred as follow-up).
- MCP `hippo_decide*` tools (HTTP/SDK only in v1, mirrors predictions' MCP deferral).
- `closure_note` / supersede-note columns (minimal v1; add if needed).
- Memory half-life pinning for active decisions (table is authoritative; recall best-effort, same as predictions).
- Package version bump + publish (release episode; additive table is non-breaking).
- Pinning the superseded memory's tags beyond the existing legacy weakening.

## Files modified

| File | Change |
|---|---|
| `src/db.ts` | Migration v30 (CREATE TABLE decisions + 2 indexes + 3 triggers); bump CURRENT_SCHEMA_VERSION 29→30. |
| `src/decisions.ts` | NEW module. |
| `src/cli.ts` | Extend `case 'decide'`; add list/get/close routing; add 3 audit ops to VALID_AUDIT_OPS; update help. |
| `src/server.ts` | 5 `/v1/decisions` routes; add 3 audit ops to VALID_AUDIT_OPS. |
| `src/audit.ts` | Extend AuditOp union with 3 ops. |
| `python/src/hippo_memory/models.py` | `Decision` model. |
| `python/src/hippo_memory/client.py` | async methods. |
| `python/src/hippo_memory/sync_client.py` | sync mirrors. |
| `python/src/hippo_memory/__init__.py` | export `Decision`. |
| `tests/decisions-store.test.ts` | NEW (store + the `resolveActiveDecisionIdByMemory` backward-compat helper + CAS). |
| `tests/audit-ops-decision-lockstep.test.ts` | NEW (pins the 3 decision ops across the 3 lockstep sites). |
| `tests/http-decisions.test.ts` | NEW (route-level CLI-equivalent coverage). |
| `python/tests/test_decisions.py` | NEW. |
| `CHANGELOG.md` | Unreleased entry. |

## Implementation tasks (ordered)

1. **Migration v30** in `src/db.ts` — append `{ version: 30, up }` after v29 (db.ts:1050), mirroring the v29 block (tableExists guard, CREATE TABLE, indexes, triggers). Bump `CURRENT_SCHEMA_VERSION` to 30.
2. **`src/decisions.ts`** — mirror predictions.ts structure: domain types, `VALID_DECISION_STATES`, `DecisionRow` + `rowToDecision`, `saveDecision` (writeEntry afterWrite: INSERT row + emit decision_create; if supersedesDecisionId, UPDATE old active row → superseded + emit decision_supersede, guard tenant+status), `closeDecision` (BEGIN IMMEDIATE + guarded UPDATE + emit decision_close), `loadDecisionById`, `loadDecisions`, `loadActiveDecisions`.
3. **`src/audit.ts`** — add the 3 ops to the union.
4. **`src/cli.ts`** — extend cmdDecide; add the 3 ops to VALID_AUDIT_OPS; update help. Reuse `extractPathTags(process.cwd())` → `extraTags`; `resolveTenantId({})` for tenant.
5. **`src/server.ts`** — 5 routes; add the 3 ops to VALID_AUDIT_OPS.
6. **Python SDK** — models + client + sync_client + __init__.
7. **Tests** (see commitments).
8. **CHANGELOG** — Unreleased, em-dash-free (grep `—` count = 0 on added lines pre-commit).

## Test commitments

- `npm run build` clean; `npm test` full suite green (the 1 pre-existing `tests/openclaw-package.test.ts` failure stays out of scope, per predictions precedent). The pre-existing `tests/decision.test.ts` (backward-compat anchor: asserts the decision memory shape — tags `['decision']`, confidence `'verified'`, source `'decision'`, half_life 90) MUST stay green.
- `cd python && pytest` green.
- `tests/decisions-store.test.ts` (real DB, ≥12 cases): dual-write creates memory AND row; afterWrite-throw atomicity (no memory row AND no decisions row land); decision_create/supersede/close audit rows; cross-tenant insert trigger ABORT; ON DELETE SET NULL (forget memory → row survives, `memory_id` NULL — also the decay-bug structural proof); supersede sets status+superseded_by+superseded_at atomically; **supersede CAS** (re-supersede an already-superseded row → throw, changes===0); close guard (active-only; not-found vs not-active errors); superseded_by cross-tenant trigger ABORT; status filters; `resolveActiveDecisionIdByMemory` (row id for a first-class decision, null for a legacy memory with no row); schema-migration v30 on a pre-v30 DB (table+indexes+triggers exist).
- `tests/audit-ops-decision-lockstep.test.ts` (NEW — the existing `audit-ops-*-lockstep` tests are per-episode hard-coded, so they will NOT break and will NOT cover the new ops): assert `decision_create`/`decision_supersede`/`decision_close` are present in cli.ts `VALID_AUDIT_OPS`, server.ts `VALID_AUDIT_OPS`, and the `AuditOp` union — pinning the 3-site lockstep for this episode.
- `tests/http-decisions.test.ts` (real DB, in-process server): 5 routes + Bearer auth + cross-tenant isolation + status-filter validation + DoS cap. This is the route-level CLI-equivalent coverage; CLI behavior is otherwise a thin wrapper over the directly-tested store helpers + `resolveActiveDecisionIdByMemory`, so no `cmdDecide` export / subprocess test is needed (matches predictions' actual test footprint — predictions ships store + http tests, no cli-predict test).
- `python/tests/test_decisions.py`: Pydantic round-trip + back-compat parse (missing optional fields) + 5 SDK methods exist.

## Success criteria

1. `hippo decide "use Postgres" --context "scale"` creates a memory (visible in `hippo recall`) AND a `decisions` row (visible in `hippo decide list`).
2. `hippo decide list --status active` returns only active decisions; closed/superseded drop out.
3. `hippo decide close <id>` flips status to `closed`; re-close errors clearly.
4. `hippo decide "use Citus" --supersedes <old-memory-id>`: old memory weakened (legacy) AND, if it had an active row, that row → `superseded` with `superseded_by` = the new decision's id (atomic).
5. HTTP create/list/get/supersede/close round-trip parity with CLI.
6. Python SDK: `await hippo.decide(...)`, `supersede_decision`, `close_decision`, `list_decisions`, `get_decision` work end-to-end.
7. `audit_log` records `decision_create` / `decision_supersede` / `decision_close` under the right tenant + actor with the specified metadata.
8. Forced afterWrite failure leaves NO decisions row AND NO new memory row.
9. Cross-tenant INSERT (memory mismatch) and cross-tenant supersede (successor mismatch) both RAISE ABORT.
10. A decision survives memory decay/deletion **by construction**: `decide list` reads the table, not the memory, so decay is irrelevant. Verified structurally by the ON DELETE SET NULL test (forget the memory → the `decisions` row still returns from `loadActiveDecisions`, `memory_id` NULL) — no 90-day simulation needed.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| `--supersedes` backward-compat regression | cli-decide test asserts legacy path (no row) still only weakens the memory; first-class path supersedes the row. |
| writeEntry afterWrite hook contract mis-used | Mirror predictions.ts savePrediction exactly (store.ts SAVEPOINT 'write_entry'); read the supersede call-site precedent before coding. |
| Atomicity of new-row + old-row supersede | Both happen inside the single afterWrite SAVEPOINT; atomicity test injects a throw. |
| Over-engineering the superseded_by tenant trigger | Justified by the self-FK + the multi-tenant composite-FK probation memory (schema-level > handler-level); flagged for critic review. |
| `decide list` text-vs-subcommand ambiguity | Accepted, same as predictions; documented in help. |
| Lockstep test breakage | Add all 3 ops to all 3 sites in one pass; run the lockstep tests in verify. |

## Verification approach (verify stage)

1. `npm run build && npm test` full suite green.
2. `cd python && pytest` green.
3. Manual smoke: `hippo decide "test" --context why` → `hippo decide list` → `hippo decide close <id>` → `hippo audit --limit 5` shows the 3 ops.
4. Migration: open a pre-v30 DB, run migration, assert table + indexes + triggers exist.
5. Atomicity proof: forced afterWrite throw leaves no orphan rows in either table.

## Effort

~1 day single engineer. Single PR off master at `27f5ae6`. Additive table (no
breaking change), schema v29→v30, no package version bump in this episode.
