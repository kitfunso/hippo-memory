# Plan: E2 first-class `process` object

- Date: 2026-05-29
- Episode: 01KSTBPPCGTJAEF48H25S6K4J8 (/dev-framework-rl, project_type=backend)
- Status: Draft (not yet engineering-reviewed)

## Goal

Promote `process` to a first-class E2 object (next after `decision` v1.15.0,
`prediction` v1.13.0, `incident` E2/Unreleased), mirroring `src/decisions.ts`
structurally. A process is a **living process map**: a named, ordered list of
steps that evolves over time. ROADMAP-RESEARCH §"Phase E2" specs it as "living
process maps with deltas".

## Key design call: the delta lifecycle IS the decision supersede path

`incident` dropped decision's supersede machinery (open->resolved->closed is not
a supersession). `process` is the opposite: its "delta" lifecycle is exactly the
decision supersede path. A process evolves by being **superseded by a new
version**; each new version records *what changed* (`change_summary`) and the
*full new state* (`steps`), and carries a derived `version` counter.

Lifecycle:

- `active` — the current version of the process (default on create).
- `superseded` — replaced by a newer version; `superseded_by` points to the
  successor, `superseded_at` is set. The row stays on record (the version chain
  is the changelog: walk `superseded_by` and read each successor's
  `change_summary`).
- `closed` — the process is retired entirely (no successor); `closed_at` set.
  Reachable from `active` only (you close the current version).

So we re-add (vs incident) decision's `superseded_by` self-FK, the supersede
CAS in the save path, the INSERT-preflight (codex P1 from the decision episode),
and the `trg_processes_supersede_tenant_match_update` trigger. We ADD beyond
decision: `steps` (JSON array body), `version` (derived counter), and
`change_summary` (the per-version delta note).

## Why supersede-as-delta and not an event log / normalized step table (grill resolution)

Brainstorm grill, strongest objection: *"supersede-as-delta is versioning with a
note, not structural step-diffing."* Resolution: the row stores enough to
**reconstruct** any delta — `predecessor.steps` + `successor.steps` +
`successor.change_summary`. Computed structural step-diffing is a read-side
presentation feature, deferred to v2 (note below). This is the minimum faithful
substrate and reuses the most existing machinery. Rejected alternatives:
normalized `process_steps` table (2 tables + step CRUD/reorder/diff — deferred,
exactly like incident deferred the `incident_receipts` join table); event-sourced
`process_deltas` log (a large architectural departure from every other E2
object, no reuse).

## Schema (migration v32)

`CURRENT_SCHEMA_VERSION` 31 -> 32. New `processes` table = the v31 incidents
tenant-match trigger pair + the v30 decisions supersede self-FK & trigger +
process-specific columns:

- `id` INTEGER PK AUTOINCREMENT
- `memory_id` TEXT, FK -> memories(id) ON DELETE SET NULL
- `tenant_id` TEXT NOT NULL
- `process_name` TEXT NOT NULL (the title/identifier)
- `description` TEXT (optional summary; mirrors decision's `context`)
- `steps` TEXT NOT NULL DEFAULT '[]' (JSON-encoded array of step strings)
- `version` INTEGER NOT NULL DEFAULT 1 (server-derived; predecessor.version + 1)
- `status` TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','closed'))
- `superseded_by` INTEGER, FK -> processes(id) ON DELETE SET NULL
- `superseded_at` TEXT
- `change_summary` TEXT (the delta note; set on a SUCCESSOR row created via supersede; NULL on a v1 initial create)
- `closed_at` TEXT
- `created_at` TEXT NOT NULL

Indexes: `idx_processes_tenant_status` (tenant_id, status), `idx_processes_memory`
(memory_id WHERE NOT NULL). Triggers (verbatim mirror, renamed): tenant-match
INSERT + UPDATE (vs the referenced memory) + supersede tenant-match UPDATE (vs
the successor process, self-FK).

## steps validation + DoS caps (grill must-add #1)

`steps` is untrusted at the HTTP/SDK boundary. On save, validate:

- `steps` must be an array of strings (reject non-array, reject non-string
  elements, reject empty-string elements after trim).
- Cap step **count** at 200 and each step **length** at 2000 chars (mirrors the
  incident DoS-cap discipline of 4096 on the route body fields). Reject with a
  clear error over the cap.
- Stored as `JSON.stringify(steps)`; read back via `JSON.parse` with a defensive
  fallback to `[]` on a malformed legacy value.

## version derivation (grill must-add #2)

`version` is **server-derived, never client-supplied**:

- Fresh create (no `supersedesProcessId`): `version = 1`.
- Supersede: `version = predecessor.version + 1`, read inside the same
  preflight SELECT that validates the predecessor is `active`.

## Module `src/processes.ts` (mirror decisions.ts)

Exports: `ProcessStatus = 'active'|'superseded'|'closed'`, `VALID_PROCESS_STATES`,
`Process` interface (incl `steps: string[]`, `version: number`,
`changeSummary: string | null`, `supersededBy: number | null`),
`SaveProcessOpts` (`processName`, `steps`, `description?`, `changeSummary?`,
`supersedesProcessId?`, `extraTags?`), `ListProcessesOpts`, `saveProcess`,
`closeProcess`, `loadProcessById`, `loadProcesses`, `loadActiveProcesses`.

Note (grill resolution): unlike `decisions.ts`, there is NO
`resolveActiveProcessIdByMemory` and NO `new --supersedes <memory-id>` flag.
Supersession is a dedicated table-id path (`saveProcess` takes
`supersedesProcessId` directly; the CLI `supersede <id>` subcommand and the HTTP
`/v1/processes/:id/supersede` route both pass the table id). The decision CLI's
`--supersedes <memory-id>` indirection exists for back-compat with the legacy
`hippo decide` memory-id contract; `process` is greenfield, so the table-id form
is the single, simpler path. (Karpathy: drop the unused resolver — YAGNI.)

- `saveProcess`: creates a memory mirror (tags `['process', ...extraTags]`,
  source 'process', confidence 'verified', layer Semantic, half_life
  `PROCESS_HALF_LIFE_DAYS`) + inserts the processes row inside the
  `writeEntry(..., {actor, afterWrite})` SAVEPOINT (dual-write atomicity,
  verbatim pattern). Validates `steps` (caps above). When `supersedesProcessId`
  is given: preflight SELECT (status='active' + read `version`) BEFORE the
  INSERT (codex P1 self-supersede guard), set new row's `version` =
  predecessor.version + 1 and `change_summary`, then CAS-UPDATE the predecessor
  `WHERE id=? AND tenant_id=? AND status='active' AND id != <new id>`; throw on
  `changes===0`. Emits `process_create` (+ `process_supersede` on the
  supersede branch). Memory mirror content = `process_name` + numbered steps +
  optional description, so recall surfaces the process body.
- `closeProcess(id)`: CAS `WHERE id=? AND tenant_id=? AND status='active'`;
  not-found vs not-active discipline. Emits `process_close`. (Only `active`
  closes; a `superseded` row is already terminal in the chain.)
- All ops `assertTenantId()` first.
- `PROCESS_HALF_LIFE_DAYS = 90` added to `src/memory.ts` (mirror
  `DECISION_HALF_LIFE_DAYS` / `INCIDENT_HALF_LIFE_DAYS`).

## 3-site audit lockstep (institutional rule)

Add `process_create`, `process_supersede`, `process_close` to ALL THREE:
`src/audit.ts` AuditOp union, `src/cli.ts` VALID_AUDIT_OPS, `src/server.ts`
VALID_AUDIT_OPS. Pinned by `tests/audit-ops-process-lockstep.test.ts`.

## CLI / HTTP / SDK (mirror decisions)

- CLI `src/cli.ts`: import processes module; `cmdProcess` with subcommands
  `new` (fresh create only; `--step "<text>"` repeatable to build steps,
  `--description`) / `list [--status]` / `get <id>` / `supersede <id>` (table-id:
  records a new active version of process `<id>`; `--step` repeatable for the new
  step list, `--change "<summary>"` for the delta note, `--description`) /
  `close <id>`; `case 'process':` dispatch; help block. `new` does NOT take a
  `--supersedes` flag — supersession is the dedicated subcommand. Strict
  positive-integer id validation on get/supersede/close (the `parsePositive*`
  pattern from the incident codex P2 — `/^\d+$/`, not lenient parseInt).
  Permissive note: `change_summary` is only meaningful on a supersession; a fresh
  `new` always stores NULL for it.
- HTTP `src/server.ts`: POST `/v1/processes` (new), GET `/v1/processes`
  (list + status filter), GET `/v1/processes/:id`, POST
  `/v1/processes/:id/supersede` (body: steps, change_summary, description),
  POST `/v1/processes/:id/close`. Reuse buildContextWithAuth / parseJsonBody /
  HttpError / sendJson; DoS caps; 404 not-found / 409 wrong-state.
- Python SDK: `Process` model (models.py + `__all__`); methods on `client.py`
  (async) + `sync_client.py` (sync): `new_process`, `supersede_process`,
  `close_process`, `list_processes`, `get_process`; `__init__.py` import +
  `__all__`. No SDK version bump this episode (staged Unreleased).

## Tests (real DB, no mocks)

- `tests/processes-store.test.ts` (mirror decisions-store + incidents-store):
  dual-write SAVEPOINT atomicity; supersede CAS (active->superseded; re-supersede
  fails not-active); self-supersede preflight guard (supersede id 1 on empty
  store does not self-reference); version derivation (v1 -> v2 -> v3 chain);
  change_summary recorded on successor only; close guard (active->closed;
  re-close fails; cannot close a superseded row); not-found vs wrong-state;
  cross-tenant triggers (memory tenant-match + supersede tenant-match);
  ON DELETE SET NULL; status filters; steps validation (non-array, non-string
  element, empty element, count cap, length cap); loadActiveProcesses.
- `tests/http-processes.test.ts` (mirror http-incidents): 5 routes,
  HIPPO_REQUIRE_AUTH gate, status validation, cross-tenant isolation, DoS cap on
  steps.
- `tests/audit-ops-process-lockstep.test.ts`: 3 ops present in
  audit.ts/cli.ts/server.ts.
- `tests/process-cli.test.ts` (mirror incident-cli; lock the codex P2 regressions
  from the incident episode pre-emptively): `process new --step ...` records the
  steps not a keyword; malformed id rejected on close/supersede and the wrong row
  is NOT mutated; new->supersede->list version chain via CLI.
- `python/tests/test_processes.py`: Pydantic round-trip + SDK method presence.
- **Schema-version bump**: 20 assertion sites 31 -> 32 (full grep-verified list):
  a3-envelope x2 (lines 11/17), a5-tenant x2 (12/13), auth-role x2 (19/26),
  b3-goal-stack x2 (12/13), dag-summary-metadata x2 (39/45),
  db-migration-v27-self-heal getMeta x2 (77/137), pr2-session-continuity x2
  (39/40), v039-gdpr-path-a x4 (37/40/110/153), v039-slack-hardening x2 (46/49).
  EXCLUDE the sequential-learning false positives (trapCount/trapTasks = 31).
  Per the prior learn delta, grep the FULL tree
  (`getCurrentSchemaVersion`/`getSchemaVersion`/`getMeta schema_version`).

## Steps (each verify-checked)

1. db.ts: bump CURRENT_SCHEMA_VERSION 31->32 + add v32 processes migration
   (incidents triggers + decisions supersede self-FK/trigger + steps/version/
   change_summary cols). verify: build; a fresh store opens at schema_version 32.
2. src/memory.ts: add `export const PROCESS_HALF_LIFE_DAYS = 90;`. Then
   src/processes.ts: write the module. verify: tsc clean.
3. audit.ts/cli.ts/server.ts: add the 3 ops (lockstep). verify:
   audit-ops-process-lockstep test passes.
4. CLI cmdProcess + dispatch + help. verify: `hippo process new/list/get/
   supersede/close` smoke.
5. HTTP /v1/processes routes. verify: http-processes test.
6. Python SDK Process + methods. verify: pytest.
7. CHANGELOG: add process entry under `## Unreleased` (em-dash-free).
8. Bump 20 schema-version test assertions 31->32; grep-confirm zero `.toBe(31)`
   schema sites / getMeta '31' remain (excluding the SL trap-count 31s).
9. Full build + vitest + pytest green.

## Risks & mitigations

- Schema-version test drift (recurring): 20 sites enumerated above (full-grep
  verified, identical to the incident list). grep-confirm zero schema `.toBe(31)`
  remain after the bump; do NOT touch the 4 sequential-learning trap-count 31s.
- Self-supersede on empty/low-id store: the codex P1 decision bug. Preflight the
  predecessor BEFORE the INSERT + `id != <new id>` exclusion in the CAS UPDATE.
- steps as untrusted input: validate array-of-non-empty-strings + count/length
  caps on save; tests assert rejection.
- version client-supply: derived server-side only; never read from the request.
- Dual-write atomicity: all mutations inside writeEntry SAVEPOINT (verbatim).
- Line endings: repo uniformly LF (.gitattributes); use targeted Edits.
- Ships via merge; staged in CHANGELOG Unreleased; NO package publish this
  episode. Stop at human deploy gate.

## Out of scope (noted)

- Computed structural step-diff (render the add/remove/reorder between two
  versions): future read-side feature.
- Normalized `process_steps` table (steps as first-class rows): future (v1 uses
  JSON array).
- Reopen / un-close: future.
- HTTP/CLI to edit steps in place WITHOUT a supersession: out of scope by design
  — every change is a new version (that is the "living map with deltas" contract).
