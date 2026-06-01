# Plan: E2 first-class `customer_note` object (entity-scoped)

- Date: 2026-06-01
- Episode: 01KT15K1701F5FS3T3E53N618Y (/dev-framework-rl, project_type=backend)
- Status: Draft (not yet engineering-reviewed)

## Goal

Promote `customer_note` to a first-class E2 object - the LAST of the 8 E2 objects
(after decision / prediction / incident / process / policy / skill / project_brief),
mirroring `src/project-briefs.ts`. ROADMAP-RESEARCH.md:313 specs it as "scoped to
account/customer entity". A customer_note is a discrete note recorded against a
customer/account entity, evolving via the supersede delta lifecycle.

## Key design: entity-scoping + discrete MANY-per-customer notes (the simplest E2 object)

This is the smallest E2 object (6d est). It has NO distinguishing assembler/renderer
(unlike skill's export or project_brief's refresh) - the contribution is purely the
entity-scoping dimension. Do NOT manufacture a feature it doesn't need (Simplicity
First).

Two design decisions settled at brainstorm+grill:

1. **Entity-scoping = a free-form `customer` column** (the `repo` analog from
   project_brief). The `entities` table is unbuilt (E3.1 `[planned]`), so a FK to it
   is deferred; the note stores a free-form customer/account identifier. When E3
   lands, `customer` can become an entity FK (future).

2. **MANY notes per customer**, NOT one-active-per-customer. A customer accrues
   multiple discrete notes over time (call notes, observations); each has its own
   supersede chain (correct a note -> a new version preserving history). This differs
   from project_brief (one evolving summary per repo). So there is NO
   "the one active note" accessor; `loadCustomerNotes(customer, status)` returns the
   list, and `loadActiveNotesForCustomer(customer)` is a thin convenience over it.

Reuses the project_brief/skill supersede machinery verbatim (superseded_by self-FK +
CAS + INSERT-preflight + server-derived version + change_summary + supersede
tenant-match trigger). Lifecycle: active -> superseded (a corrected version) or
active -> closed (retired).

## Entity-aware recall tag (applying the project_brief codex P2 lesson)

`saveCustomerNote` tags the note's memory mirror with `customer:<customer>` (lowercased)
in addition to `['customer_note']` plus any caller `extraTags`. This makes notes
entity-recall-able from the start - directly applying the lesson from the
project_brief episode (codex P2: a scoped object's mirror must carry its scope tag so
path/scope-aware recall treats it as entity-local). Follows the existing
`<type>:<value>` tag convention (`path:`, `speaker:`, `topic:`).

## Schema (migration v36) - reserved-word check (rule 10): `customer` + `note` both NON-reserved

`CURRENT_SCHEMA_VERSION` 35 -> 36. New `customer_notes` table = the v35 project_briefs
table with `repo`/`summary` replaced by `customer`/`note`:

- `id` INTEGER PK AUTOINCREMENT
- `memory_id` TEXT, FK -> memories(id) ON DELETE SET NULL
- `tenant_id` TEXT NOT NULL
- `customer` TEXT NOT NULL  (the entity-scoping dimension; free-form account/customer id)
- `note` TEXT NOT NULL  (the note body)
- `version` INTEGER NOT NULL DEFAULT 1
- `status` TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','closed'))
- `superseded_by` INTEGER, FK -> customer_notes(id) ON DELETE SET NULL
- `superseded_at` TEXT
- `change_summary` TEXT
- `closed_at` TEXT
- `created_at` TEXT NOT NULL

Reserved-word check (codebase-audit rule 10): `customer`, `note`, `version`, `status`,
`change_summary`, `closed_at`, etc. - none is a SQLite reserved keyword. No `trigger`
-class collision.

Indexes: `idx_customer_notes_tenant_status` (tenant_id, status),
`idx_customer_notes_memory` (memory_id WHERE memory_id NOT NULL),
`idx_customer_notes_customer` (tenant_id, customer, status) for the per-customer
lookup. Triggers (verbatim mirror, renamed): tenant-match INSERT + UPDATE (vs memory)
+ supersede tenant-match UPDATE (self-FK). `if (!tableExists(...))` guarded.

## Validation / DoS caps

- `customer` required, trimmed, single-line (no newlines - it becomes a tag +
  identifier), <= `MAX_CUSTOMER_LEN = 256`; `note` required, <= `MAX_NOTE_LEN = 8192`
  (a body); `change_summary` <= `MAX_CHANGE_SUMMARY_LEN = 4096`. Enforced at the store
  (throws) + HTTP boundary (400).

## Module `src/customer-notes.ts` (mirror project-briefs.ts, drop refresh)

Exports: `NoteStatus`, `VALID_NOTE_STATES`, `CustomerNote` (incl `customer`, `note`,
`version`, `changeSummary`, `supersededBy`), `SaveCustomerNoteOpts` (`customer`,
`note`, `changeSummary?`, `supersedesNoteId?`, `extraTags?`), `ListCustomerNotesOpts`
(`status?`, `customer?`, `limit?`), `saveCustomerNote`, `closeCustomerNote`,
`loadCustomerNoteById`, `loadCustomerNotes`, `loadActiveNotesForCustomer`,
`CUSTOMER_NOTE_HALF_LIFE_DAYS` (in memory.ts = 90).

- `saveCustomerNote`: memory mirror (tags `['customer_note', 'customer:<lc>',
  ...extra]`, source 'customer_note', confidence 'verified', layer Semantic, half_life
  CUSTOMER_NOTE_HALF_LIFE_DAYS) + customer_notes row in the writeEntry SAVEPOINT.
  Supersede preflight (status='active' + version) BEFORE INSERT; CAS `id != newId`;
  server-derived version; change_summary. Emits `customer_note_create`
  (+ `customer_note_supersede`). Memory content = `customer\n\nnote`.
- `closeCustomerNote(id)`: CAS active-only; `customer_note_close`.
- `loadCustomerNotes`: status + customer filters (dynamic WHERE, mirror
  loadProjectBriefs); ORDER BY created_at DESC, id DESC; default limit 100.
- `loadActiveNotesForCustomer(customer)`: thin wrapper = loadCustomerNotes({customer,
  status:'active'}). Returns the LIST (many-per-customer).
- NO refresh/assemble (rule 9 cross-cap N/A: no generate-then-store path).

## 3-site audit lockstep

`customer_note_create`, `customer_note_supersede`, `customer_note_close` in audit.ts
AuditOp union + cli.ts VALID_AUDIT_OPS + server.ts VALID_AUDIT_OPS (after the
project_brief ops). Pinned by `tests/audit-ops-customer-note-lockstep.test.ts`.

## CLI / HTTP / SDK (mirror project-briefs; reuse shared helpers)

- CLI `cmdCustomerNote` (keyword `note`, alias `customer-note`): `new <customer>
  --text "<note>"` / `list [--status] [--customer]` / `get <id>` / `supersede <id>
  --text "<note>" [--change]` / `close <id>`. Strict `parsePositiveNoteId` (`/^\d+$/`).
  No repeatable flags. (Confirm `note` is not an existing CLI keyword before wiring;
  fall back to `customer-note` only if it collides.)
- HTTP `/v1/customer-notes`: POST (new), GET (list + status + customer; **reuse the
  shared `parseListLimit`**), GET `/v1/customer-notes/:id`, POST
  `/v1/customer-notes/:id/supersede`, POST `/v1/customer-notes/:id/close`. 5 routes
  (no /refresh). DoS caps; 404/409 mapping. `/:id` digits-anchored regex.
- Python SDK: `CustomerNote` model + `new_customer_note` / `supersede_customer_note`
  / `close_customer_note` / `list_customer_notes` / `get_customer_note` (async +
  sync); `__init__` + BOTH `__all__` lists (models.py AND __init__.py - codex P3
  carry-forward).

## Tests (real DB, no mocks)

- `tests/customer-notes-store.test.ts`: dual-write SAVEPOINT atomicity; supersede CAS
  + version chain + self-supersede preflight; close guard (active-only;
  cannot-close-superseded; cannot re-close); not-found vs wrong-state; cross-tenant
  triggers (memory + supersede); ON DELETE SET NULL + old-version-loadable; status +
  customer filters; **many-notes-per-customer** (2+ active notes for one customer,
  both returned); `loadActiveNotesForCustomer`; memory mirror carries
  `customer:<lc>` tag; validation (missing customer/note; single-line customer; caps);
  schema v36 table + 3 triggers + 3 indexes.
- `tests/http-customer-notes.test.ts`: POST/GET/get/supersede/close, auth gate, status
  + customer filter validation, cross-tenant isolation, DoS cap, fractional-limit 400
  (confirms shared parseListLimit covers the new route).
- `tests/audit-ops-customer-note-lockstep.test.ts`: 3 ops in the 3 sites.
- `tests/customer-note-cli.test.ts`: `note new <customer>` arg-shift (codex P2 class:
  the `new` keyword is not recorded as the customer); malformed-id rejected on
  close/supersede; new->supersede version chain; many-notes-per-customer list.
- `python/tests/test_customer_notes.py`: Pydantic round-trip + 5 SDK method presence
  (async+sync) + both __all__ contain CustomerNote.
- **Schema-version bump**: 20 assertion sites 35 -> 36 (18x `.toBe(35)` across 8 files
  + 2x `'35'` string in db-migration-v27-self-heal; binary-mode script; physics
  `toBe(32)` untouched; `toBe(getCurrentSchemaVersion())` sites auto-follow).

## Steps (each verify-checked)

1. db.ts: CURRENT_SCHEMA_VERSION 35->36 + v36 customer_notes migration.
2. src/memory.ts CUSTOMER_NOTE_HALF_LIFE_DAYS=90; src/customer-notes.ts module.
3. audit.ts/cli.ts/server.ts: 3 ops lockstep.
4. CLI cmdCustomerNote + dispatch + help + examples (verify `note` keyword is free).
5. HTTP /v1/customer-notes routes (reuse parseListLimit).
6. Python SDK CustomerNote + 5 methods + both __all__.
7. CHANGELOG Unreleased entry (em-dash-free).
8. 20 schema-version assertions 35->36; grep-confirm zero schema `.toBe(35)` remain.
9. Full build + vitest + pytest green.

## Risks & mitigations

- Reserved word (rule 10): customer/note checked, both safe.
- Cross-cap (rule 9): N/A - no assembler; note body capped directly at the store/HTTP.
- CLI keyword collision: confirm `note` is free; else use `customer-note` as primary.
- Self-supersede / dual-write: project_brief preflight + CAS verbatim.
- Sibling-clone (rule 8): REUSE parseListLimit; mirror project_briefs, audit the
  pattern (don't replicate a latent bug).
- Entity-recall tag: `customer:<lc>` applied on save (project_brief codex-P2 lesson).
- models.__all__ AND __init__.__all__ both updated (codex P3).
- Schema-version drift: 20 sites; grep-confirm post-bump.
- Line endings: targeted Edits (repo uniformly LF).
- codex review MUST be cwd-pinned to the hippo repo (cd hippo && codex review
  --uncommitted; verify the workdir line) - the 2026-05-30 cwd-drift learn-delta.
- Ships via merge; CHANGELOG Unreleased; NO publish.

## Out of scope (noted)

- FK to an `entities` table (E3.1 unbuilt): future; free-form `customer` for now.
- Any assembler/digest/export (customer_note is discrete notes, not a summary): not
  needed - project_brief already covers the per-repo summary case.
- Structured customer/account schema, note categories/types, threading: future.
