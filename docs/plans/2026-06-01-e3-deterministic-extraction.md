# Plan: E3.1 deterministic entity extraction (first slice)

- Date: 2026-06-01
- Episode: 01KT2023EGD1F7J52FKAJ4D40D (/dev-framework-rl, project_type=backend)
- Status: Draft (not yet engineering-reviewed)

## Goal

Populate the E3 graph (built + guarded in the E3.3 episodes) from the already-
structured consolidated E2 objects, DETERMINISTICALLY (no NLP, no 80%-precision gate).
This is the first slice of E3.1 ("entity extraction at sleep") - the structured-object
path. The NLP prose-extraction (extracting entities from raw/distilled prose memories,
the 12d gold-set part) is the deferred follow-up. This slice makes the graph real +
queryable so E3.2 multi-hop recall has something to traverse.

## Design

### `src/graph.ts`: add `clearGraph(hippoRoot, tenantId): number`

DELETE FROM entities WHERE tenant_id = ? (relations cascade via the FK). Returns the
deleted entity count. Lives in graph.ts (the sanctioned graph writer), so the E3.3
CI lint allows its `DELETE FROM entities`. This is the rebuild primitive.

### `src/graph-extract.ts` (NEW): `extractGraph(hippoRoot, tenantId): ExtractResult`

Idempotent REBUILD: the graph is a pure derived function of the current E2 state.
1. `clearGraph(tenantId)` - wipe the tenant's deterministic graph.
2. For each of the 4 E2-object types whose type matches the `entity_type` enum, load
   ACTIVE + SUPERSEDED rows (exclude `closed` = retired), up to
   `MAX_EXTRACT_PER_TYPE = 10000` each (documented bound; the default loader limit is
   100). Skip rows with a NULL `memory_id` (forgotten source - cannot reference).
   For each, `insertEntity({ entityType, name, memoryId })` (the guard enforces the
   consolidated source). Record `entityIdByKey[(type, e2Id)] = entity.id`.

   | E2 table        | entity_type | name field      |
   |-----------------|-------------|-----------------|
   | decisions       | `decision`  | `decisionText`  |
   | policies        | `policy`    | `policyName`    |
   | customer_notes  | `customer`  | `customer`      |
   | project_briefs  | `project`   | `repo`          |

   (`skill` / `incident` / `process` are NOT in the entity_type enum, so they are out
   of this slice - adding them needs an enum expansion, deferred.)
3. `supersedes` relations: for each loaded object X with `supersededBy = Y` (Y is the
   SUCCESSOR), if BOTH X and Y were extracted to entities, `insertRelation({
   fromEntityId: entityOf(Y), toEntityId: entityOf(X), relType: 'supersedes',
   memoryId: Y.memoryId })` - Y supersedes X. Skip if either entity is missing (e.g.
   Y is `closed`). The entity name is TRUNCATED to MAX_ENTITY_NAME_LEN (512) in the
   extractor before insertEntity (the E2 name fields are uncapped at source and
   insertEntity REJECTS, not truncates, an over-cap name - which after clearGraph would
   brick the rebuild; codex + independent-review 2026-06-01).
4. Return `{ entities, relations, byType: { decision, policy, customer, project } }`.

`graph-extract.ts` calls only the `graph.ts` helpers (insertEntity / insertRelation /
clearGraph) + the E2 loaders - NO raw SQL - so the E3.3 lint stays clean.

### `src/cli.ts`: `hippo graph extract`

`cmdGraph` (keyword `graph`, confirmed free): subcommand `extract` -> `extractGraph`,
print the counts (`Extracted N entities (decision a, policy b, customer c, project d)
+ M supersedes relations.`). Operator-invoked; idempotent (safe to re-run).

## Idempotency + atomicity (grill-acknowledged)

- Rebuild => `extractGraph` output is a pure function of current E2 state; re-running
  yields the same graph (tested). Because this is the SOLE graph producer today, a
  full clear-and-rebuild is correct. NOTE: when a second producer (NLP E3.1) lands,
  extraction will need a `source`/`origin` marker so the rebuild scopes to only the
  deterministically-extracted rows; flagged, not built now.
- The clear + inserts run across graph.ts's per-call DB connections (not one txn). A
  mid-extract crash leaves a partial graph; a re-run rebuilds it cleanly (idempotent).
  Acceptable for a derived, operator-rebuilt graph; a transactional batch API is a
  future optimisation, not needed for correctness here.

## Tests (real DB, no mocks) - `tests/graph-extract.test.ts`

- Seed via the real save APIs: decisions (incl a v1->v2 supersede chain), a policy, a
  customer_note, a project_brief. `extractGraph` -> assert per-type entity counts +
  the entity_type/name mapping + a `supersedes` relation for the chain (from v2 to v1).
- Idempotency: run `extractGraph` twice -> identical counts, no duplicate entities.
- Excludes `closed`: a closed decision -> no entity.
- Skips NULL memory_id: a decision whose memory was deleted (ON DELETE SET NULL) -> no
  entity (and no crash).
- `supersedes` skipped when the successor is not an entity (e.g. closed).
- `clearGraph`: returns the count + cascades relations (entities + relations both 0
  after).
- Entities reference consolidated (non-raw) memories (inherited from the guard; the
  E2 mirrors are `distilled`).

## Steps (each verify-checked)

1. src/graph.ts: add `clearGraph`.
2. src/graph-extract.ts: `extractGraph` + `MAX_EXTRACT_PER_TYPE` + `ExtractResult`.
3. src/cli.ts: `cmdGraph` + dispatch (`graph`) + help + example.
4. tests/graph-extract.test.ts.
5. CHANGELOG Unreleased entry (em-dash-free).
6. build + vitest (+ the E3.3 lint still passes: graph-extract.ts uses helpers, no raw SQL).

## Risks & mitigations

- Rebuild wipes all graph rows: correct as sole producer; `source` marker noted for the
  NLP follow-up.
- Non-atomic clear+insert: idempotent re-run fixes a partial graph; acceptable.
- Loader default limit 100: extractor passes `MAX_EXTRACT_PER_TYPE = 10000`; documented
  bound (a tenant with >10k of one E2 type would under-extract - log/note, not a
  realistic case now).
- id collision across E2 tables: the entity map is keyed by `(entityType, e2Id)`, not
  bare id, so a decision #1 and a policy #1 don't collide.
- NULL memory_id (forgotten source): skipped (entities.memory_id is NOT NULL).
- E3.3 lint: graph-extract.ts uses graph.ts helpers (no raw SQL); clearGraph's DELETE
  lives in the sanctioned graph.ts. Lint stays green.
- NO schema/migration/audit-ops change. Reuses the v37 guard.
- codex review cwd-PINNED; all hippo bash commands cwd-prefixed.
- Ships via merge; CHANGELOG Unreleased; NO publish.

## Out of scope

- NLP prose-extraction from raw/distilled memories (the 80%-precision gold-set): the
  big E3.1 follow-up. This slice is the deterministic structured-object path.
- `skill` / `incident` / `process` entities (need an entity_type enum expansion).
- Cross-object relations beyond `supersedes` (e.g. customer_note -> customer
  `references`, incident -> linked_memory_ids): future.
- The `hippo sleep` enqueue-hook + auto-extract-on-sleep (this is operator-invoked
  `hippo graph extract` for now).
- E3.2 multi-hop recall (the operator query surface): next, enabled by this.
- `hippo graph stats`/`list` view commands: not needed (extract prints its counts).
