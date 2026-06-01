# Plan: E3.3 graph-on-consolidated guard (DB substrate + DB-level enforcement)

- Date: 2026-06-01
- Episode: 01KT1N4XC3JFJ5YK7FQ4XXZKCE (/dev-framework-rl, project_type=backend)
- Status: Shipped. plan-eng-critic retry-1 PASS (round 1 caught an INSERT-only guard ->
  added BEFORE UPDATE triggers). codex review then caught the reverse direction: a P1
  (mutating a referenced memory to raw post-insertion) + 2 P2 mutation edges, fixed by
  adding two reverse-guard triggers (`trg_memories_graph_referenced_guard` on memories;
  `trg_entities_no_tenant_move_when_referenced` on entities). So the SHIPPED migration v37
  has **8 guard triggers** (6 graph-table INSERT/UPDATE + 2 reverse guards), superseding
  the "3 triggers" the draft body below describes. Central invariant ("graph never indexes
  raw") is DB-enforced unrepresentable on every path: insert, graph-table update, and
  memory/entity mutation.

## Goal

Ship the first slice of the E3 graph layer: the **graph-on-consolidated guard**
(ROADMAP-RESEARCH.md E3.3, the only E3 item marked `[next]`). The hard rule the
graph must obey: **it never indexes the raw layer** - `entities` and `relations`
reference only consolidated memories (`kind IN ('distilled','superseded')`), never
`kind='raw'`. This slice delivers the DB substrate + the DB-level enforcement; E3.1
(entity extraction at sleep, the NLP/precision work) and E3.2 (multi-hop recall) and
the pipeline enqueue-hook + CI lint are explicit follow-ups.

## Scope (and what is deferred)

IN: migration v37 (`entities`, `relations`, `graph_extraction_queue` tables with FK +
CHECK + raw-rejection triggers); `src/graph.ts` (a thin insert/load/enqueue API that
surfaces the guard as throws); real-DB tests incl the E3.3 success criterion
(`INSERT INTO entities` with a raw-FK fails). NO CLI/HTTP/SDK - the graph is internal
infrastructure until E3.2 makes it operator-facing. NO new audit ops - graph writes
are internal (no operator action) and become meaningful when E3.1 wires extraction;
adding the 3-site lockstep now would be premature.

DEFERRED (follow-ups): E3.1 entity extraction at sleep (NLP; 80%-precision gold-set);
E3.2 multi-hop recall (`hippo recall --hops`); the consolidation **enqueue hook**
(pipeline-level: `hippo sleep` enqueues distilled writes); the **CI lint** (E3.3
success criterion 2: a lint that fails PRs writing to the graph from non-consolidated
state). This slice delivers E3.3 success **criterion 1** (regression test:
raw-FK insert fails); criterion 2 (lint) is the fast-follow.

## Schema (migration v37) - NEW tables, so real CHECK constraints (unlike ALTER'd memories)

`CURRENT_SCHEMA_VERSION` 36 -> 37. Three new tables, all carrying the envelope
(`tenant_id`) + the consolidated-source guard. Reserved-word check (rule 10):
`entities`, `relations`, `graph_extraction_queue` and every column
(`entity_type`/`name`/`source_kind`/`rel_type`/`from_entity_id`/`to_entity_id`/
`memory_id`/`tenant_id`/`status`/`enqueued_at`/`processed_at`/`created_at`) are
non-reserved; `rel_type` avoids the `REFERENCES` keyword.

```sql
CREATE TABLE entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person','project','customer','system','policy','decision')),
  name TEXT NOT NULL,
  memory_id TEXT NOT NULL,                 -- the consolidated source row
  source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled','superseded')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE TABLE relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  from_entity_id INTEGER NOT NULL,
  to_entity_id INTEGER NOT NULL,
  rel_type TEXT NOT NULL CHECK (rel_type IN ('owns','supersedes','depends-on','blocked-by','references')),
  memory_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled','superseded')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE TABLE graph_extraction_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('distilled','superseded')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','skipped')),
  enqueued_at TEXT NOT NULL,
  processed_at TEXT,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
```

Indexes: `idx_entities_tenant` (tenant_id), `idx_entities_memory` (memory_id),
`idx_relations_tenant` (tenant_id), `idx_relations_from` (from_entity_id),
`idx_relations_to` (to_entity_id), `idx_relations_memory` (memory_id),
`idx_graph_queue_status` (tenant_id, status). All `if (!tableExists(...))` guarded.

### DB-level enforcement triggers (the E3.3 guard) - INSERT *and* UPDATE

Per table, BOTH a BEFORE INSERT and a BEFORE UPDATE trigger (the subquery-capable
SELECT-CASE pattern used by the sibling memory-FK tables - e.g.
`trg_predictions_tenant_match_insert`/`_update` at db.ts:1026-1047, NOT the
literal-only v14 `trg_memories_kind_check_insert` which has no subquery). Both
INSERT and UPDATE are required: an INSERT-only guard is bypassable via a raw SQL
`UPDATE entities SET memory_id='<raw_id>'`, which would re-create exactly the
raw-on-graph state the guard forbids. The invariant must be DB-level unrepresentable
regardless of code path (plan-eng-critic 2026-06-01, HIGH).

A single combined check per trigger (one `SELECT CASE` with two WHEN arms):
- **kind/source guard:** ABORT if `NEW.source_kind` != the FK'd memory's actual kind
  (`(SELECT kind FROM memories WHERE id = NEW.memory_id)`). Combined with the
  `source_kind IN ('distilled','superseded')` CHECK, this makes a raw FK *or* a lying
  `source_kind` both ABORT (a raw memory's kind can never equal a CHECK-valid
  source_kind).
- **tenant guard:** ABORT if `NEW.tenant_id` != the memory's tenant_id.

- `trg_entities_consolidated_only_insert` (BEFORE INSERT) +
  `trg_entities_consolidated_only_update` (BEFORE UPDATE, fires `WHEN NEW.memory_id IS
  NOT OLD.memory_id OR NEW.source_kind IS NOT OLD.source_kind OR NEW.tenant_id IS NOT
  OLD.tenant_id`).
- `trg_relations_consolidated_only_insert` + `_update` (same shape).
- `trg_graph_queue_consolidated_only_insert` + `_update`: guard on `NEW.kind` ==
  the memory's actual kind (+ tenant-match); UPDATE fires when memory_id/kind/tenant_id
  change.

CASCADE rationale: `memory_id` is NOT NULL (a graph node MUST have a consolidated
source). ON DELETE CASCADE keeps the graph strictly consistent with live consolidated
state - forgetting a consolidated memory removes its entities, and their relations
cascade. E3.4 (graph quality maintenance: tombstone vs versioned edges, `[research]`)
will revisit; CASCADE is the correct simple default for this slice. (Note: the A3
`trg_memories_raw_append_only` already forbids deleting raw memories, so the CASCADE
only ever fires for distilled/superseded sources.)

## Module `src/graph.ts` (internal infra API; surfaces the guard as throws)

Exports: `EntityType`, `RelationType`, `GraphQueueStatus` + `VALID_*` sets; `Entity`,
`Relation`, `GraphQueueItem` interfaces; `GRAPH_ENTITY_TYPES` etc.

- `insertEntity(hippoRoot, tenantId, { entityType, name, memoryId })`: reads the
  source memory (must exist, same tenant, kind != 'raw'); derives `source_kind` from
  the memory's kind; INSERTs. Throws a clear error on not-found / cross-tenant / raw
  BEFORE hitting the trigger (the trigger is the DB backstop). Returns the Entity.
- `insertRelation(hippoRoot, tenantId, { fromEntityId, toEntityId, relType, memoryId })`:
  validates both entities exist in-tenant + the source memory (non-raw); INSERTs.
- `loadEntities(hippoRoot, tenantId, { entityType?, limit? })`,
  `loadRelations(hippoRoot, tenantId, { limit? })`, `loadEntityById`.
- `enqueueExtraction(hippoRoot, tenantId, memoryId)`: enqueues a consolidated memory
  for later extraction (kind derived; raw rejected). `loadExtractionQueue(tenantId,
  { status?, limit? })`. (The producer hook in `hippo sleep` is deferred; this is the
  API that hook + E3.1 will call.)
- Input validation: `name` required + capped (`MAX_ENTITY_NAME_LEN = 512`);
  entityType/relType validated against the VALID sets (defensive, in addition to the
  DB CHECK).

## Tests (real DB, no mocks)

- `tests/graph-store.test.ts`: insertEntity from a distilled memory (source_kind set);
  insertRelation links two entities; **E3.3 CRITERION 1 - raw-FK rejection BOTH via
  the helper (throws) AND via a direct `INSERT INTO entities` raw SQL (INSERT trigger
  ABORTs)**; **UPDATE-path guard (raw SQL, no helper): `UPDATE entities SET
  memory_id=<raw_id>` ABORTs, and `UPDATE entities SET source_kind=<mismatch>` ABORTs**
  (the BEFORE UPDATE trigger - the bypass the plan-eng-critic caught); lying-source_kind
  on INSERT rejected (trigger); cross-tenant entity->memory rejected on INSERT and
  UPDATE (trigger); cross-tenant relation->entity rejected; bad entity_type / rel_type
  / source_kind rejected (CHECK); enqueueExtraction (distilled enqueues; raw rejected;
  queue kind-mismatch ABORTs on INSERT and UPDATE); ON DELETE CASCADE (delete a
  distilled memory -> its entities + their relations + queue rows vanish);
  loadEntities/loadRelations filters; name cap.
- `tests/graph-schema.test.ts`: schema v37 produces the 3 tables + 7 indexes + 3
  guard triggers; CHECK constraints present.
- **Schema-version bump**: 20 assertion sites 36 -> 37 (18x `.toBe(36)` across 8 files
  + 2x `'36'` string in db-migration-v27-self-heal; binary-mode script; physics
  `toBe(32)` untouched; dynamic `toBe(getCurrentSchemaVersion())` sites auto-follow).

## Steps (each verify-checked)

1. db.ts: CURRENT_SCHEMA_VERSION 36->37 + v37 migration (3 tables, 7 indexes, 3 guard triggers).
2. src/graph.ts module (types + insert/load/enqueue API + guard pre-checks).
3. CHANGELOG Unreleased entry (em-dash-free).
4. tests/graph-store.test.ts + tests/graph-schema.test.ts.
5. 20 schema-version assertions 36->37; grep-confirm zero schema `.toBe(36)` remain.
6. Full build + vitest + pytest green.

## Risks & mitigations

- Reserved word (rule 10): table + column names checked, all safe.
- Cross-cap (rule 9): N/A (no assembler).
- CHECK can't subquery: the FK'd-memory-kind match is enforced by a trigger, not a
  CHECK (the CHECK only constrains the literal `source_kind`); both together guarantee
  non-raw. Mirror of the v14 memories kind-check trigger.
- CASCADE aggressiveness: NOT NULL memory_id + ON DELETE CASCADE keeps the graph
  consistent with live consolidated state; E3.4 (`[research]`) revisits. Tested.
- Scope discipline: NO CLI/HTTP/SDK/audit-ops/Python this slice (graph is internal
  until E3.2). Enqueue hook + CI lint deferred (criterion 2).
- Schema-version drift: 20 sites; grep-confirm post-bump.
- Line endings: targeted Edits (repo uniformly LF).
- codex review cwd-PINNED to hippo (`cd hippo && codex review --uncommitted`; verify
  the `workdir:` line) + ALL feature-repo bash commands cwd-prefixed (the generalized
  cwd-drift lesson).
- Ships via merge; CHANGELOG Unreleased; NO publish.

## Out of scope (noted)

- E3.1 entity extraction at sleep (the NLP; 80%-precision gold set): follow-up.
- E3.2 multi-hop graph recall (`hippo recall --hops`): follow-up.
- The consolidation **enqueue hook** (`hippo sleep` feeds the queue): follow-up
  (this episode ships the queue table + API the hook will call).
- The **CI lint** (E3.3 criterion 2): fast-follow.
- E3.4 graph quality maintenance (tombstone / versioned edges on supersession):
  `[research]`.
- Operator surface (CLI/HTTP/SDK): lands with E3.2 recall.
