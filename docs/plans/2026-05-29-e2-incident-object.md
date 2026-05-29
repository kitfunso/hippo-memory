# Plan: E2 first-class `incident` object

- Date: 2026-05-29
- Episode: 01KSSRFZ3H8CDB1DBREH68GZQK (/dev-framework-rl, project_type=backend)
- Status: Draft (not yet engineering-reviewed)

## Goal

Promote `incident` to a first-class E2 object (next after `decision` v1.15.0 /
`prediction` v1.13.0), mirroring `src/decisions.ts` structurally. An incident is
a postmortem capsule: a recorded operational event with a lifecycle and optional
linked receipts (the memories that are its evidence).

## Key design call: lifecycle is open -> resolved -> closed (NOT supersede)

Decisions supersede (a newer decision replaces an older one). Incidents do NOT.
An incident's lifecycle is:

- `open` — active incident (default on create).
- `resolved` — a resolution was recorded (`resolution_text`, `resolved_at`); the
  incident stays on record.
- `closed` — retired (`closed_at`). Reachable from `open` or `resolved`.

So we drop decision's `superseded_by` self-FK, its supersede CAS, and the
supersede tenant-match trigger. We add `resolution_text` + `resolved_at`. Ops:
`resolveIncident` (open -> resolved) and `closeIncident` (open|resolved ->
closed). Reopen is deferred (note as future; keep v1 clean).

## Schema (migration v31)

`CURRENT_SCHEMA_VERSION` 30 -> 31. New `incidents` table (mirror v30 decisions
block minus the supersede pieces):

- `id` INTEGER PK AUTOINCREMENT
- `memory_id` TEXT, FK -> memories(id) ON DELETE SET NULL
- `tenant_id` TEXT NOT NULL
- `incident_text` TEXT NOT NULL (the title/summary)
- `context` TEXT
- `status` TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','closed'))
- `resolution_text` TEXT
- `resolved_at` TEXT
- `closed_at` TEXT
- `linked_memory_ids` TEXT NOT NULL DEFAULT '[]' (JSON array of memory ids; scoped v1)
- `created_at` TEXT NOT NULL

Indexes: `idx_incidents_tenant_status` (tenant_id, status), `idx_incidents_memory`
(memory_id WHERE NOT NULL). Triggers: `trg_incidents_tenant_match_insert` +
`trg_incidents_tenant_match_update` (memory-tenant match, verbatim mirror of the
decisions INSERT/UPDATE triggers). No supersede trigger (no self-FK).

## linked_memory_ids (the "linked receipts") — scoped v1

Stored as a JSON-encoded array of memory ids on the row, default `[]`. v1
validation: on save, assert each linked id exists in the SAME tenant (reuse the
tenant-scoped read) and drop/reject cross-tenant ids — keeps the relation safe
without a join table. A normalized `incident_receipts` join table is deferred
(note as future). This is the one place incident exceeds the decision pattern;
flagged for plan-eng-critic.

## Module `src/incidents.ts` (mirror decisions.ts)

Exports: `IncidentStatus = 'open'|'resolved'|'closed'`, `VALID_INCIDENT_STATES`,
`Incident` interface, `saveIncident`,
`resolveIncident`, `closeIncident`, `loadIncidentById`, `loadIncidents`,
`loadOpenIncidents`, `resolveActiveIncidentIdByMemory`.

- `saveIncident`: creates a memory mirror (tags `['incident', ...extraTags]`,
  source 'incident', confidence 'verified', half_life INCIDENT_HALF_LIFE_DAYS)
  + inserts the incidents row inside the `writeEntry(..., {actor, afterWrite})`
  SAVEPOINT (dual-write atomicity, verbatim pattern). Validates linked_memory_ids
  tenant-match before insert.
- `resolveIncident(id, resolutionText)`: CAS `UPDATE ... SET status='resolved',
  resolution_text=?, resolved_at=? WHERE id=? AND tenant_id=? AND status='open'`;
  `changes===0` -> distinguish not-found (SELECT) from not-open. Emits
  `incident_resolve`.
- `closeIncident(id)`: CAS `WHERE id=? AND tenant_id=? AND status IN ('open','resolved')`;
  same not-found-vs-wrong-state discipline. Emits `incident_close`.
- All ops `assertTenantId()` first. saveIncident emits `incident_open`.

## 3-site audit lockstep (institutional rule)

Add `incident_open`, `incident_resolve`, `incident_close` to ALL THREE:
`src/audit.ts` AuditOp union, `src/cli.ts` VALID_AUDIT_OPS, `src/server.ts`
VALID_AUDIT_OPS. Pinned by `tests/audit-ops-incident-lockstep.test.ts`.

## CLI / HTTP / SDK (mirror decisions)

- CLI `src/cli.ts`: import incidents module; `cmdIncident` with subcommands
  `open` (default create) / `list [--status]` / `get <id>` / `resolve <id>
  --resolution "<text>"` / `close <id>`; `case 'incident':` dispatch; help block.
- HTTP `src/server.ts`: POST `/v1/incidents` (open), GET `/v1/incidents`
  (list + status filter), GET `/v1/incidents/:id`, POST `/v1/incidents/:id/resolve`,
  POST `/v1/incidents/:id/close`. Reuse buildContextWithAuth / parseJsonBody /
  HttpError / sendJson; DoS caps 4096; 404 not-found / 409 wrong-state.
- Python SDK: `Incident` model (models.py + `__all__`); 5 methods on `client.py`
  (async) + `sync_client.py` (sync): `open_incident`, `resolve_incident`,
  `close_incident`, `list_incidents`, `get_incident`; `__init__.py` import + `__all__`.

## Tests (real DB, no mocks)

- `tests/incidents-store.test.ts` (mirror decisions-store): dual-write SAVEPOINT
  atomicity, resolve CAS (open->resolved; re-resolve fails not-open), close guard
  (open/resolved->closed; re-close fails), not-found vs wrong-state, cross-tenant
  triggers, ON DELETE SET NULL, status filters, linked_memory_ids tenant-match
  rejection, loadOpenIncidents.
- `tests/http-incidents.test.ts` (mirror http-decisions): 5 routes, HIPPO_REQUIRE_AUTH
  gate, status validation, cross-tenant isolation, DoS cap.
- `tests/audit-ops-incident-lockstep.test.ts`: 3 ops present in audit.ts/cli.ts/server.ts.
- `python/tests/test_incidents.py`: Pydantic round-trip + SDK method presence.
- **Schema-version bump**: 20 assertion sites 30 -> 31 (VERIFIED by full tests/ grep,
  was undercounted at 14): a3-envelope x2, a5-tenant x2, auth-role x2, b3-goal-stack
  x2, dag-summary-metadata x2, pr2-session-continuity x2, **v039-gdpr-path-a x4
  (lines 37/40/110/153)**, **v039-slack-hardening x2 (lines 46/49)**; and
  db-migration-v27-self-heal getMeta '30'->'31' x2. Per the prior learn delta, grep
  the FULL tree (`getCurrentSchemaVersion`/`getSchemaVersion`/`getMeta schema_version`),
  not the manifest.

## Steps (each verify-checked)

1. db.ts: bump CURRENT_SCHEMA_VERSION 30->31 + add v31 incidents migration. verify: build; a fresh store opens at schema_version 31.
2. src/memory.ts: add `export const INCIDENT_HALF_LIFE_DAYS = 90;` (mirror `DECISION_HALF_LIFE_DAYS` at src/memory.ts:123). Then src/incidents.ts: write the module (imports INCIDENT_HALF_LIFE_DAYS from memory.ts). verify: tsc clean.
3. audit.ts/cli.ts/server.ts: add the 3 ops (lockstep). verify: audit-ops-incident-lockstep test passes.
4. CLI cmdIncident + dispatch + help. verify: `hippo incident open/list/get/resolve/close` smoke.
5. HTTP /v1/incidents routes. verify: http-incidents test.
6. Python SDK Incident + methods. verify: pytest.
7. CHANGELOG: add incident entry under `## Unreleased` (em-dash-free).
8. Bump all 20 schema-version test assertions 30->31 (full list in Tests above); grep-confirm zero `.toBe(30)` / getMeta '30' remain.
9. Full build + vitest + pytest green.

## Risks & mitigations

- Schema-version test drift (prior incident): 20 sites enumerated above (full-grep
  verified; was undercounted at 14 by both the audit and the first plan draft, caught
  by plan-eng-critic). grep-confirm zero `.toBe(30)` remain after the bump.
- linked_memory_ids cross-tenant leak: validated tenant-match on save + the JSON
  is opaque text (no FK), so no trigger needed; tests assert rejection.
- Dual-write atomicity: all mutations inside writeEntry SAVEPOINT (verbatim pattern).
- Line endings: repo uniformly LF (.gitattributes); use targeted Edits.
- Ships via merge; staged in CHANGELOG Unreleased; NO package publish this episode
  (a future release episode version-bumps). Stop at human deploy gate.

## Out of scope (noted)

- Reopen op (resolved/closed -> open): future.
- Normalized `incident_receipts` join table: future (v1 uses JSON array).
- HTTP route to mutate linked_memory_ids after open: future (set at open time).
