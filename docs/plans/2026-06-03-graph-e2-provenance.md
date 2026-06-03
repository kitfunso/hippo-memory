# Plan: Anchor graph entity/relation provenance to the authoritative E2 object

Status: IN BUILD (episode 01KT6PY1H6EWDQF85R30Z15XWJ; worktree feat/graph-e2-provenance off origin/master@7963506). The E3 graph code IS on master (shipped via squash #86/#87/#88/#94); open branches feat/e3.1-cross-object-references, feat/e3.2-multihop-recall, feat/e3-sleep-enqueue still touch graph-extract.ts/graph-recall.ts/db.ts -> flag merge-time overlap at deploy.
Date: 2026-06-03
Owner: /dev-framework-rl episode, project_type=library

## Problem

An in-force E2 object (decision / policy / customer-note / project-brief) silently
disappears from the knowledge graph once its mirror memory is gone. This happens not
only via an explicit `hippo forget <mirror-id>`, but naturally over time: the mirror
memory is created with a half-life (`decisions.ts:152`, `DECISION_HALF_LIFE_DAYS`) and
is eligible for decay-driven pruning by consolidation (`hippo sleep`) while the E2
object stays `active` and authoritative.

Reproduce (verified 2026-06-02 on `feat/e3-sleep-enqueue-hook`):
1. `hippo policy new "X" --text "..."` ; `hippo decide "... mentions X ..."`
2. `hippo graph extract` -> entities + `references`/`supersedes` arcs present.
3. `hippo forget <decision-mirror-id>` (or let consolidation prune it).
4. `hippo graph extract` -> the still-active decision is GONE from the graph
   (extraction skips it), though `decide list` still shows it as active.

## Root cause

E3 graph extraction anchors entity/relation **provenance to the decaying memory
mirror**, not to the authoritative E2 row:

- `entities.memory_id` / `relations.memory_id` are `NOT NULL` (db.ts:1683, 1699).
- The consolidated-source guard ties `source_kind` to the FK'd memory's live `kind`
  via `BEFORE INSERT/UPDATE` triggers (`trg_entities_consolidated_only_*`,
  `trg_relations_consolidated_only_*`, db.ts:1730-1790) and `resolveConsolidatedSource`
  in graph.ts. Every entity/relation therefore requires a LIVE distilled/superseded
  memory row.
- Extraction skips rows whose mirror is gone: `graph-extract.ts:180`
  `if (row.memoryId === null) continue;`.

Meanwhile the E2 design (db.ts:1055-1059) is explicit that the **table is the source of
truth** and the memory is "kept for recall but is no longer authoritative; memory_id is
NULLABLE with ON DELETE SET NULL so forget/consolidate/archive does not lose a decision."

So the graph re-introduces exactly the decay-coupling that promoting `hippo decide` to a
canonical E2 table was built to eliminate for recall (db.ts:1055-1057) -- one layer up.

## NOT the fix (rejected)

- Cascade `forget` to delete the E2 row, or block `forget` and force `close`:
  contradicts the documented design. `SET NULL` exists precisely so forget/consolidate
  do NOT lose the authoritative object. Cascading would destroy the source of truth.
- Pin the mirror / exclude E2 mirrors from pruning: fights the "mirror may be dropped"
  design and re-introduces non-decaying mirrors (the thing E2 moved away from). Masks
  the explicit-forget trigger only; does not address the design mismatch.

## Fix (recommended): anchor provenance to the E2 object

The guard's real invariant is "the graph indexes consolidated state only (no raw)". For
an E2 object, "consolidated" is established by being an E2 object at all -- not by a
memory's `kind`. So ADD an authoritative-object provenance path alongside the existing
memory-kind path (keep the latter for prose / future NLP-sourced entities).

### Change surface (audit-informed, concrete)

**1. Migration v38** (current head is v37; graph tables were created in v37). The graph
is a PURE DERIVED CACHE (`clearGraph` + rebuild on every `graph extract` / `sleep`), so
v38 does NOT copy data -- it DROPs and recreates the two changed tables and repopulates
on the next extract. `graph_extraction_queue` schema is unchanged (left alone).

- `DROP TABLE relations;` then `DROP TABLE entities;` (relations FK entities -> drop
  child first). Recreate both with:
  - `memory_id TEXT` (NULLABLE; was `NOT NULL`) `REFERENCES memories(id) ON DELETE SET NULL`
    (was CASCADE -- now a null-able recall pointer that survives mirror loss, matching the
    E2 tables' own `ON DELETE SET NULL`). FK-action/guard interaction: SQLite FK actions do
    NOT fire triggers unless `recursive_triggers` is ON, so the `ON DELETE SET NULL` will not
    trip the rewritten BEFORE UPDATE guard; the execute stage MUST confirm hippo's
    `recursive_triggers` PRAGMA state and, if ON, prove the all-null guard tolerates the
    SET-NULL transition for an E2-sourced row (which still has `source_object_*`, so it stays
    valid). Today every entity is E2-sourced (extraction is 100% E2-driven; prose/NLP is
    deferred), so a SET NULL never yields an all-null row in practice.
  - new `source_object_type TEXT` CHECK in (`decision|policy|customer|project`) + `source_object_id INTEGER`,
    both NULLABLE (memory-sourced prose/NLP entities have these null; E2-sourced entities
    have these set).
  - `source_kind` stays, but is now derivable from EITHER path.
  - Recreate indices (`idx_entities_tenant/memory`, `idx_relations_tenant/from/to/memory`)
    + a new partial index `idx_entities_source_object ON entities(source_object_type, source_object_id) WHERE source_object_id IS NOT NULL`.
- Recreate EVERY trigger that lives ON the dropped tables (verified against the full v37
  DDL db.ts:1660-1866) -- there are **5**, not 4:
  1. `trg_entities_consolidated_only_insert` (REWRITTEN for dual-provenance)
  2. `trg_entities_consolidated_only_update` (REWRITTEN)
  3. `trg_relations_consolidated_only_insert` (REWRITTEN)
  4. `trg_relations_consolidated_only_update` (REWRITTEN)
  5. `trg_entities_no_tenant_move_when_referenced` (recreated AS-IS -- queries relations by
     entity id; logic unchanged). **This is the one the round-1 critic caught as missing.**
  NOT recreated (correctly): `trg_memories_graph_referenced_guard` lives on the **memories**
  table (db.ts:1838), which v38 does NOT drop, so it survives. It stays correct for the
  nullable change: its `EXISTS (... WHERE memory_id = OLD.id)` checks never match a
  null-memory entity, so a mirror-less entity simply does not constrain any memory's
  kind/tenant (which is right). `trg_graph_queue_consolidated_only_{insert,update}` are on
  `graph_extraction_queue` (not dropped) -> survive, not recreated.

**2. Guard rework -- BOTH sites kept in lockstep (audit rule 2):**
- **SQL triggers (db.ts).** Rewrite `trg_*_consolidated_only_{insert,update}` to enforce
  "AT LEAST ONE valid provenance, no raw": (a) if `memory_id IS NOT NULL` then
  `source_kind` must equal the FK'd memory's `kind` AND that kind is `distilled|superseded`
  (raw still ABORTs); (b) if `memory_id IS NULL` then `source_object_type/id` must reference
  an EXISTING same-tenant E2 row whose status is `active|superseded` (not `closed`); (c)
  reject the all-null case (`RAISE(ABORT, 'graph row needs a memory or a source object')`).
  Keep the cross-tenant ABORT.
- **Rule 11 bidirectional (parent-side).** Today `trg_memories_graph_referenced_guard`
  blocks `UPDATE memories SET kind='raw'` while referenced. Add the analogous E2-side
  protection: an E2 row referenced by a graph entity via `source_object_*` must not be
  hard-DELETEd out from under it -- but since the graph is a rebuilt cache and E2 rows are
  `close`d (status change) not deleted, the chosen handling is: `source_object_id` carries
  NO hard FK (it is a soft (type,id) pointer the rebuild re-validates), and a `closed`
  status simply makes the next extract drop the entity. State this explicitly; do NOT add a
  hard FK that would block legitimate E2 hard-deletes. (The forward trigger already rejects
  an entity pointing at a `closed`/absent object at insert time.)
- **TS `resolveConsolidatedSource` (graph.ts:184).** Signature becomes
  `(db, tenantId, memoryId: string | null, sourceObject: {type,id} | null, label)`; returns
  `source_kind`. memory path unchanged (looks up kind, rejects raw); object path validates
  the E2 row is active|superseded same-tenant and sets `source_kind='distilled'` (E2 objects
  are consolidated by construction). 3 callers updated: `insertEntity:230`, `insertRelation:269`,
  `enqueueExtraction:585` (the enqueue path stays memory-keyed -> passes the memory, null object).

**3. graph.ts `insertEntity` / `insertRelation`:** add optional
`sourceObject?: {type,id}` to `InsertEntityOpts`/`InsertRelationOpts`; `memoryId` becomes
`string | null`. Insert `source_object_type/id`. Both go through the reworked guard.

**4. graph-extract.ts:** Pass 1 no longer `continue`s on `memoryId === null` for an E2
row -- it always creates the entity, anchored to the E2 row via `sourceObject:{type,id}`,
passing `memoryId` only when the mirror still exists. Pass 2 (`supersedes`) + Pass 3
(`references`) attach `sourceObject` of the EDGE's sourcing E2 object (the successor for
supersedes; the source object for references), `memoryId` optional. `closed` E2 rows are
still excluded (loadType loads active+superseded only -- unchanged). The `created`/
`memoryIdByKey` maps gain the object key so edges can carry it.

**5. graph-recall.ts + graph-stream.ts (null-safety -- see Deferred for surfacing).**
`Entity.memoryId` (graph.ts:57, set by `rowToEntity`:138) widens from `string` to
`string | null`. Both consumers of `Entity.memoryId` must be made null-safe (mirror-less
entities cannot be lexical seeds -- seeds come from `loadEntitiesByMemoryId` over base recall
results -- but they CAN be reached by traversal):
- **graph-recall.ts** (`produceHitsForRoot`): (a) `originMemByEntityId` becomes
  `Map<number, string | null>` and the seed `.set(se.id, se.memoryId)` (line 121) tolerates
  null; (b) the reached-id load at line ~153
  `reachedEntities.map(e => e.memoryId).filter(id => !seenMemoryIds.has(id))` must DROP null
  ids before they reach `loadByIdsChunked`/the `Set<string>` (a null entity has no mirror to
  load); (c) `loadedById.get(ent.memoryId)` at line ~165 with null -> `undefined` -> the
  existing `if (!mem) continue` correctly skips it (mirror-less node not recall-surfaced).
- **graph-stream.ts** (L1 RRF graph stream, #94): `strengthByMemId.get(e.memoryId)` (line
  125, already `?? 0`) and `memIdToIndex.get(ent.memoryId)` (line 182) must skip/short-circuit
  on a null `memoryId` rather than look up `null`. Seeds here are also memory-derived so
  null-memory entities only appear as reached nodes.
This episode VERIFIES both with tests and adds NO new surfacing. The recall/stream paths do
not regress; mirror-less nodes are simply not recall-surfaced (they ARE in entities/relations
for `graph extract`/visualization, which IS the reported bug).

**6. Version-bump (audit rule 3) -- CORRECTED COUNT: 21 assertions across 10 files** (a
full `tests/` grep, not a head-limited one): `CURRENT_SCHEMA_VERSION` 37 -> 38 (db.ts:26)
AND every hard-coded `37`:
- a5-tenant-migration.test.ts:12,13
- a3-envelope-migration.test.ts:11,17
- auth-role-migration.test.ts:19,26
- b3-goal-stack-migration.test.ts:12,13
- dag-summary-metadata.test.ts:39,45
- db-migration-v27-self-heal.test.ts:77,137 (string `'37'` -> `'38'`)
- graph-schema.test.ts:28
- pr2-session-continuity.test.ts:39,40  (omitted in round 1)
- v039-slack-hardening.test.ts:46,49     (omitted in round 1)
- v039-gdpr-path-a.test.ts:37,40,110,153 (omitted in round 1)

(pr3-working-memory.test.ts reads it dynamically via `getCurrentSchemaVersion()` -- no
change.) The verify stage runs the FULL suite, so a missed assertion hard-fails there.
NOT an npm version bump: deploy = merge; the npm/schema RELEASE is a separate follow-up
episode.

**7. Caller ripple (audit rule 5):**
- `insertEntity`/`insertRelation` callers: graph-extract.ts (above) + 6 test files use them
  directly (graph-store, graph-stream, graph-extract, graph-recall, graph-sleep-hook,
  search-graph-stream-rrf). Back-compat: a memory-only call still compiles since
  `sourceObject` is optional and `memoryId` stays accepted -- but the type widens, so TS will
  flag any site that assumed non-null.
- `Entity.memoryId` consumers (the now-nullable field): **src/graph-recall.ts AND
  src/graph-stream.ts** (both MODULES, per section 5) -- not just the graph-stream TEST file.
  Confirm with a grep for `\.memoryId` across `src/` that no other module dereferences it
  assuming non-null.

### Test plan (real DB, no mocks)

**Success criterion (explicit):** after a mirror is forgotten or pruned, the active E2 object
STAYS in the `entities`/`relations` TABLES (asserted by querying those tables directly, not
via recall). That is the reported bug; recall surfacing of mirror-less nodes is out of scope.

- forget-then-extract: active object STAYS in entities/relations (direct table query); arcs preserved; its `memory_id` is now NULL and `source_object_type/id` is set.
- consolidation-prune-then-extract: mirror pruned -> object STAYS in entities/relations.
- `closed` E2 object: still excluded (status, not mirror presence, drives exclusion).
- raw memory: still REJECTED by the guard (no-raw invariant intact).
- multihop recall traverses an entity whose mirror was forgotten.
- supersedes + references edges survive a mirror forget on either endpoint.

## Risks / sequencing

- Touches the E3.3 guard + a migration; both live ONLY on the active `feat/e3-*`
  branches (not v1.18.0 / master at scope time). Heavy concurrent multi-agent activity
  on those branches -> build in worktree isolation and land AFTER E3 merges to master,
  or coordinate explicitly with the E session. Do not churn the guard under them.
- Migration + guard + recall change -> mandatory plan-eng + codex review before code
  (Outside Voice). Watch the scored-BFS visited-ordering and the cached-doc-vector
  gating lessons from the L1 v1.21.0 episode when editing graph-recall.

## Resolved decisions (were open questions)

- `references` edge whose source object is active but mirror pruned: KEEPS firing --
  provenance is the object.
- Backfill: REBUILD-ONLY. v38 DROPs+recreates the cache; the next `graph extract`/`sleep`
  repopulates. No row copy (graph entity ids are already non-stable across rebuilds, so
  nothing depends on them persisting).
- `source_object_id` is a SOFT (type,id) pointer, not a hard FK -- the rebuild re-validates
  it -- so a legitimate E2 hard-delete is never blocked; a `closed` E2 row drops at next
  extract.

## Deferred from THIS episode (tracked follow-up)

- **Synthesize-from-E2-object recall surfacing.** Making a mirror-less E2 object surfaceable
  via `recall --multihop` (load the E2 object by `source_object_*`, build a synthetic
  `SearchResult` from its text + score it) is a real additional chunk (new loaders, synthetic
  MemoryEntry shape, scoring/temporal rules). This episode delivers the actual reported bug
  (the object STAYS in the graph for `extract`/visualization) + recall null-safety. Recall
  surfacing of mirror-less nodes is a clean follow-up.

- **Tenant-level graph-rebuild signal (codex review round 6) — coordinate with e3-sleep-enqueue.**
  The graph is a GLOBALLY-derived cache, but its rebuild scheduling (`graph_extraction_queue`)
  is memory-keyed, so it cannot express "rebuild this whole tenant." Two paths this episode
  added need that and currently leave the graph UNDER-derived until the next memory-write dirty
  event (self-healing; data never lost):
  1. **v38 cache-drop on upgrade.** The migration DROP+recreates entities/relations; a store
     with no pending queue items has no tenant for `sleep` to rebuild, so the graph is empty
     until a manual `hippo graph extract` or the next write. (The npm-RELEASE episode should
     also consider preserving the rows via a copy-migration instead of drop-empty.)
  2. **Mirrorless-object close.** `removeGraphEntitiesForObject` targeted-deletes the closed
     object's rows, but references are derived globally (e.g. closing one of two same-name
     policies should un-suppress an ambiguous edge elsewhere) — only a full rebuild derives
     that. With no queued item, sleep does not re-derive until the next dirty event.
  Proper fix: a tenant-level dirty/rebuild signal (e.g. a `graph_dirty_tenants` row or a
  tenant-scoped queue entry), enqueued after the v38 invalidation and on a mirrorless close.
  This is sleep/enqueue-subsystem territory (the concurrent `feat/e3-sleep-enqueue` branch owns
  the queue), so it is deferred to coordinate with that branch rather than churn the queue here.
  Accepted for THIS episode (deploy = merge to master, not the npm release) by operator decision
  at the codex review-cap gate; the guard correctness (rounds 1-5) is fully fixed.

## Grill (self-interrogation, plan stage)

- *Weakest premise:* "an entity with null memory_id but a valid source_object is still
  'consolidated, not raw'." Defence: E2 objects (decisions/policies/notes/briefs) are
  consolidated BY CONSTRUCTION -- they are never raw ingest; the no-raw invariant is about
  excluding `kind='raw'` MEMORIES, which the memory path still enforces. The object path
  can only point at an E2 table row, none of which are raw. So the invariant holds.
- *What would falsify the design:* a graph entity that is NEITHER from an E2 object NOR a
  distilled/superseded memory. The all-null guard branch makes that unrepresentable.
- *Scope-creep check:* the tempting over-reach is rebuilding recall surfacing now; explicitly
  deferred above. The tempting under-reach is leaving graph-recall to crash on null memory;
  covered by the null-safety test.
- *Migration risk:* DROP+recreate loses no irreplaceable data (pure cache) BUT must recreate
  EVERY trigger + index the v37 DDL created, or a guard silently disappears. The plan
  enumerates all 5 triggers + all indices; the verify stage greps the recreated schema to
  confirm none dropped.

## Execute checklist (plan-eng round 2 advisories -- must be honoured in code)

1. **Object-path guard = explicit 4-way CASE.** SQLite cannot parametrize a table name in a
   trigger/CHECK, so the object-path validation (both the SQL trigger branch AND the TS
   `resolveConsolidatedSource` object path) must branch on `source_object_type` with one arm
   per E2 table: `decision`->`decisions`, `policy`->`policies`, `customer`->`customer_notes`,
   `project`->`project_briefs`, each subquerying that table's `status IN ('active','superseded')`
   and same-tenant. This 4-branch structure is the most error-prone piece -- write it
   explicitly, test each of the 4 types.
2. **SET NULL leaves `source_kind` untouched -- by design.** When a mirror delete nulls
   `memory_id` via `ON DELETE SET NULL`, the row's `source_kind` keeps its old value and is
   NOT re-derived. The reworked guard only re-checks `source_kind` against the memory when
   `memory_id IS NOT NULL`, so a stale `source_kind` on a null-memory row is intentionally
   tolerated (object path is distilled-by-construction). Do NOT add code to "fix" it.
   (`recursive_triggers` is default-OFF and never set in `openHippoDb`, so the SET NULL does
   not fire the BEFORE UPDATE guard -- confirmed; assert this in a test.)
3. **graph-view.ts is an audited-SAFE Entity consumer.** It reads only `e.id/entityType/name`
   (never `e.memoryId`), so the nullable widening is safe there -- named here so the
   execute-stage `\.memoryId` grep does not treat it as a surprise. The only `Entity.memoryId`
   derefs to fix are in graph-recall.ts and graph-stream.ts.
4. **Pass 2/3 edge-emit guard switches from memory-presence to entity-presence.** Today Pass 2
   gates on `yMemoryId === undefined -> continue` (graph-extract.ts ~249-256) and Pass 3 uses
   `src.memoryId` as the edge's source (~336-342). After the fix, a null-memory successor/
   source must STILL emit its edge, so switch the guard to `entityIdByKey` presence and carry
   the edge's `source_object` (Pass 2 = successor's object; Pass 3 = source object), with
   `memoryId` optional.
