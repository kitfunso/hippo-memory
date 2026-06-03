/**
 * E3.1 deterministic entity extraction (first slice)
 * (docs/plans/2026-06-01-e3-deterministic-extraction.md).
 *
 * Populates the E3 graph from the already-structured consolidated E2-object tables -
 * NO NLP, no precision gate for entities + supersedes. The graph is a pure derived
 * function of the current E2 state, so `extractGraph` is an idempotent REBUILD: clear
 * the tenant's graph, then re-derive entities + `supersedes` relations from decisions /
 * policies / customer_notes / project_briefs (the four E2 types whose kind maps to the
 * `entity_type` enum). All writes go through the src/graph.ts consolidated-source guard
 * (insertEntity / insertRelation / clearGraph); this module issues no raw SQL.
 *
 * Pass 3 (E3 cross-object, docs/plans/2026-06-02-e3-cross-object-references.md) adds the
 * first CROSS-OBJECT relations: a deterministic NAME-MATCH heuristic that emits a
 * `references` edge when one consolidated object's text contains another entity's name.
 * It is conservative (word-boundary, length-bounded, ambiguity-guarded, per-source
 * capped); its precision is measured + reported, not assumed.
 *
 * Deferred (follow-ups): NLP prose-extraction (semantic depends-on / blocked-by / owns);
 * skill/incident/process entities (not in the entity_type enum - needs a migration); the
 * `hippo sleep` enqueue-hook.
 */

import { clearGraph, insertEntity, insertRelation, runGraphRebuildTransaction, MAX_ENTITY_NAME_LEN, type EntityType, type GraphTxDb, type SourceObjectType, type SourceObjectRef } from './graph.js';
import { loadDecisions } from './decisions.js';
import { loadPolicies } from './policies.js';
import { loadCustomerNotes } from './customer-notes.js';
import { loadProjectBriefs } from './project-briefs.js';
import { assertTenantId } from './store.js';

/** Per-type load cap (the loaders default to 100). A type whose active or superseded
 *  set exceeds this is truncated; `ExtractResult.truncated` records it so the
 *  incompleteness is observable rather than silent. */
export const MAX_EXTRACT_PER_TYPE = 10000;

// --- Pass 3 (cross-object references) tunables ------------------------------------
/** A target entity name must be in [MIN, MAX] chars to be matched: MIN skips short /
 *  generic words; MAX skips prose (a decision's prose name is never a target, only a
 *  source). */
export const MIN_REF_NAME_LEN = 4;
export const MAX_REF_NAME_LEN = 80;
/** Per-source cap so one object cannot explode the graph with references edges. */
export const MAX_REFERENCES_PER_OBJECT = 25;
/** Regex-size bound: at most this many distinct target names enter the combined
 *  alternation, keeping the scan regex sane on a huge store. */
export const MAX_TARGET_NAMES = 5000;

export interface ExtractResult {
  entities: number;
  relations: number;
  /** Of `relations`, how many are cross-object `references` edges (the rest are
   *  `supersedes`). Surfaced so the heuristic's output volume is observable. */
  references: number;
  /** Entity count per extracted type. */
  byType: Record<string, number>;
  /** Entity types whose active or superseded load hit MAX_EXTRACT_PER_TYPE (the graph
   *  is under-extracted for those). */
  truncated: string[];
}

/** A consolidated E2 row normalised to the fields extraction needs. */
interface ExtractRow {
  entityType: EntityType;
  /** The E2 table id (unique only WITHIN its table, hence keyed with entityType). */
  e2Id: number;
  name: string;
  /** The object's full text searched for OTHER entities' names in Pass 3. */
  searchText: string;
  memoryId: string | null;
  /** The successor's E2 id (Y) when this row (X) is superseded; null otherwise. */
  supersededBy: number | null;
}

/** Stable map key: entity types share an id space across tables, so key by both. */
function keyOf(entityType: EntityType, e2Id: number): string {
  return `${entityType}:${e2Id}`;
}

/** The four E2-derived extraction entity types map 1:1 to source_object_type. */
const ENTITY_TYPE_TO_SOURCE_OBJECT: Partial<Record<EntityType, SourceObjectType>> = {
  decision: 'decision',
  policy: 'policy',
  customer: 'customer',
  project: 'project',
};

/** The E2 source-object ref for an extraction row (always set: every extracted row is an
 *  E2 object). Throws on an unmappable entityType (a graph invariant violation). */
function sourceObjectOf(entityType: EntityType, e2Id: number): SourceObjectRef {
  const type = ENTITY_TYPE_TO_SOURCE_OBJECT[entityType];
  if (!type) throw new Error(`graph-extract: entityType '${entityType}' has no source_object_type mapping`);
  return { type, id: e2Id };
}

/** Escape a string for safe use as a literal inside a RegExp alternation. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Unordered entity-id pair key, so a relation between a,b is found in either direction. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Load a type's ACTIVE + SUPERSEDED rows (excluding `closed` = retired), normalised.
 * Calls the loader once per status so MAX_EXTRACT_PER_TYPE is a per-status budget
 * (closed rows never consume it). Sets `hitCap` when either status load is full.
 */
function loadType(
  hippoRoot: string,
  tenantId: string,
  entityType: EntityType,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadFn: (root: string, tenant: string, opts: any) => any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nameOf: (row: any) => string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  textOf: (row: any) => string,
): { rows: ExtractRow[]; hitCap: boolean } {
  const rows: ExtractRow[] = [];
  let hitCap = false;
  for (const status of ['active', 'superseded'] as const) {
    const loaded = loadFn(hippoRoot, tenantId, { status, limit: MAX_EXTRACT_PER_TYPE });
    if (loaded.length === MAX_EXTRACT_PER_TYPE) hitCap = true;
    for (const r of loaded) {
      rows.push({
        entityType,
        e2Id: r.id as number,
        name: nameOf(r),
        searchText: textOf(r),
        memoryId: (r.memoryId ?? null) as string | null,
        supersededBy: (r.supersededBy ?? null) as number | null,
      });
    }
  }
  return { rows, hitCap };
}

/** A Pass-1-created entity, the unit Pass 3 traverses (never `allRows` - a row with an
 *  empty name produced NO entity and must never be a references source). Carries its E2
 *  source object so a references edge stays anchored to the object even when the mirror
 *  memory is gone (memoryId null). */
interface CreatedEntity {
  entityId: number;
  entityType: EntityType;
  /** The source mirror memory, or null once forgotten/pruned (the edge then anchors to
   *  the source object only). */
  memoryId: string | null;
  /** The E2 source object this entity descends from (always set). */
  sourceObject: SourceObjectRef;
  name: string;
  searchText: string;
  /** True when this row was superseded by a successor. References are extracted among
   *  ACTIVE entities only - an edge to/from a superseded (outdated) row is stale (codex). */
  superseded: boolean;
}

/**
 * Idempotent rebuild of the tenant's deterministic graph from its consolidated E2
 * objects. Returns the entity/relation counts (+ which types were truncated at the
 * per-type cap). Safe to re-run: output is a pure function of the current E2 state.
 */
export function extractGraph(hippoRoot: string, tenantId: string): ExtractResult {
  assertTenantId('extractGraph', tenantId);

  const sources: Array<{
    entityType: EntityType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loadFn: (root: string, tenant: string, opts: any) => any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nameOf: (row: any) => string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    textOf: (row: any) => string;
  }> = [
    { entityType: 'decision', loadFn: loadDecisions, nameOf: (r) => r.decisionText, textOf: (r) => [r.decisionText, r.context].filter(Boolean).join(' ') },
    { entityType: 'policy', loadFn: loadPolicies, nameOf: (r) => r.policyName, textOf: (r) => [r.policyName, r.policyText].filter(Boolean).join(' ') },
    { entityType: 'customer', loadFn: loadCustomerNotes, nameOf: (r) => r.customer, textOf: (r) => [r.customer, r.note].filter(Boolean).join(' ') },
    { entityType: 'project', loadFn: loadProjectBriefs, nameOf: (r) => r.repo, textOf: (r) => [r.repo, r.summary].filter(Boolean).join(' ') },
  ];

  // READ PHASE: load every source's rows on their own connections BEFORE the
  // write transaction. Holding the rebuild's BEGIN IMMEDIATE write lock while
  // opening a second connection for these reads dead-locks ('database is
  // locked'); preloading keeps the transaction single-connection.
  const loaded = sources.map((src) => {
    const { rows, hitCap } = loadType(hippoRoot, tenantId, src.entityType, src.loadFn, src.nameOf, src.textOf);
    return { entityType: src.entityType, rows, hitCap };
  });

  // WRITE PHASE (codex P2): clear + every insert run in ONE transaction, so two
  // concurrent rebuilds serialize on the SQLite write lock (no duplicate rows)
  // and a throw mid-rebuild rolls back the clear (no bricked graph). No second
  // connection is opened inside.
  return runGraphRebuildTransaction(hippoRoot, tenantId, (txDb) =>
    rebuildGraphRows(txDb, hippoRoot, tenantId, loaded),
  );
}

/**
 * The deterministic rebuild WRITES, run inside `runGraphRebuildTransaction`'s
 * transaction (`txDb` is its connection). Clears the tenant's graph then
 * re-derives entities + `supersedes` + `references` from the preloaded rows. All
 * DB access here is on `txDb` (or in-memory) — no other connection is opened.
 */
function rebuildGraphRows(
  txDb: GraphTxDb,
  hippoRoot: string,
  tenantId: string,
  loaded: Array<{ entityType: EntityType; rows: ExtractRow[]; hitCap: boolean }>,
): ExtractResult {
  // Rebuild from scratch: the graph is derived, so clear then re-derive.
  clearGraph(hippoRoot, tenantId, txDb);

  const byType: Record<string, number> = {};
  const truncated: string[] = [];
  const allRows: ExtractRow[] = [];
  const entityIdByKey = new Map<string, number>();
  // The mirror memory per extracted key, null once forgotten/pruned (so a supersedes
  // edge anchors to the successor's object when the mirror is gone but still passes the
  // memory through when it lives).
  const memoryIdByKey = new Map<string, string | null>();
  // Created entities ONLY (drives Pass 3 sources + targets), in stable insertion order.
  const created: CreatedEntity[] = [];

  // Pass 1: entities. Every ACTIVE/SUPERSEDED E2 row becomes an entity ANCHORED to its
  // authoritative E2 object (source_object_type/id) - it survives a forgotten mirror
  // (memory_id NULL). The mirror memory is passed through only when it still exists
  // (it remains a recall pointer until forgotten/pruned).
  for (const { entityType, rows, hitCap } of loaded) {
    if (hitCap) truncated.push(entityType);
    byType[entityType] = 0;
    for (const row of rows) {
      allRows.push(row);
      // Normalise the label so a long/odd-but-valid E2 name can never throw in
      // insertEntity and (because clearGraph already ran) brick the rebuild
      // unrebuildably. E2 name fields (decisionText / policyName) are UNCAPPED at
      // source, and insertEntity REJECTS (not truncates) both an over-cap name AND an
      // empty one. So: TRIM FIRST (codex 2026-06-01: >512 leading-whitespace chars
      // would otherwise slice to a whitespace-only string -> trimmed to '' ->
      // 'name is required' throw), THEN cap to MAX_ENTITY_NAME_LEN; if the normalised
      // label is empty (the E2 save APIs forbid this, but be defensive) skip the row
      // rather than throw. This closes the entire name-brick class.
      const name = (row.name ?? '').trim().slice(0, MAX_ENTITY_NAME_LEN);
      if (name.length === 0) continue;
      const sourceObject = sourceObjectOf(row.entityType, row.e2Id);
      const entity = insertEntity(hippoRoot, tenantId, {
        entityType: row.entityType,
        name,
        memoryId: row.memoryId,
        sourceObject,
      }, txDb);
      const k = keyOf(row.entityType, row.e2Id);
      entityIdByKey.set(k, entity.id);
      memoryIdByKey.set(k, row.memoryId);
      created.push({ entityId: entity.id, entityType: row.entityType, memoryId: row.memoryId, sourceObject, name, searchText: row.searchText ?? '', superseded: row.supersededBy !== null });
      byType[entityType] += 1;
    }
  }

  // Pass 2: `supersedes` relations. For X superseded by Y (Y is the successor), emit
  // "Y supersedes X" - but only when BOTH X and Y were EXTRACTED (e.g. Y may be closed
  // and absent). The emit guard is ENTITY presence (entityIdByKey), not memory presence:
  // a forgotten successor mirror must still emit the edge. The relation is anchored to Y's
  // authoritative E2 object; Y's mirror memory is passed only when it still lives.
  let relations = 0;
  // Entity-id pairs already related by supersedes (unordered). Pass 3 skips a references
  // edge for such a pair: a version-extends-its-predecessor's-name containment (e.g.
  // "Adopt X (managed)" contains "Adopt X") is a name artifact, not a cross-reference,
  // and supersedes already captures their relationship.
  const supersededPairs = new Set<string>();
  for (const row of allRows) {
    if (row.supersededBy === null) continue;
    const xKey = keyOf(row.entityType, row.e2Id);
    const yKey = keyOf(row.entityType, row.supersededBy);
    const fromId = entityIdByKey.get(yKey); // successor Y
    const toId = entityIdByKey.get(xKey); // superseded X
    if (fromId === undefined || toId === undefined) continue;
    const yMemoryId = memoryIdByKey.get(yKey) ?? null; // successor's mirror, null if gone
    insertRelation(hippoRoot, tenantId, {
      fromEntityId: fromId,
      toEntityId: toId,
      relType: 'supersedes',
      memoryId: yMemoryId,
      sourceObject: sourceObjectOf(row.entityType, row.supersededBy), // successor Y's object
    }, txDb);
    supersededPairs.add(pairKey(fromId, toId));
    relations += 1;
  }

  // Pass 3: cross-object `references` edges via conservative name matching. A source's
  // text containing a target entity's name -> "source references target". Sources +
  // targets are CREATED entities only, each anchored to its E2 source object (so the
  // edge survives a forgotten source mirror).
  const references = extractReferences(hippoRoot, tenantId, created, supersededPairs, truncated, txDb);
  relations += references;

  const entities = created.length;
  return { entities, relations, references, byType, truncated };
}

/**
 * Pass 3. Build a target-name index from the created entities (names within the length
 * bounds, ambiguous names dropped), scan each created entity's text once with one
 * combined word-boundary regex, and emit `references` edges (self-skipped, deduped,
 * per-source capped). Each edge is anchored to the source entity's E2 object (memoryId
 * passed through only when the mirror lives). Returns the number of references edges written.
 */
function extractReferences(
  hippoRoot: string,
  tenantId: string,
  created: CreatedEntity[],
  supersededPairs: Set<string>,
  truncated: string[],
  txDb: GraphTxDb,
): number {
  // Build the target index: normalised name -> single entity id. A name is a target only
  // if its length is in bounds; a name shared by >1 entity is AMBIGUOUS and dropped.
  const nameToId = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const e of created) {
    // References are among ACTIVE entities only: a superseded (outdated) row is not a
    // current cross-reference target (codex).
    if (e.superseded) continue;
    // Decisions are SOURCE-only: their name is decision prose, referenced by supersedes,
    // not by name-mention. Excluding them as targets also prevents a decision's own name
    // (== its searchText) from whole-string self-matching and shadowing embedded targets.
    if (e.entityType === 'decision') continue;
    const norm = e.name.trim().toLowerCase();
    if (norm.length < MIN_REF_NAME_LEN || norm.length > MAX_REF_NAME_LEN) continue;
    if (ambiguous.has(norm)) continue;
    if (nameToId.has(norm)) {
      // Second distinct entity with this name (and not its own id repeated) -> ambiguous.
      if (nameToId.get(norm) !== e.entityId) {
        nameToId.delete(norm);
        ambiguous.add(norm);
      }
      continue;
    }
    nameToId.set(norm, e.entityId);
  }
  if (nameToId.size === 0) return 0;

  // Record the truncation (observability, mirroring MAX_EXTRACT_PER_TYPE) so a >cap
  // store's under-matched references are not silent.
  if (nameToId.size > MAX_TARGET_NAMES) truncated.push('references-targets');
  // LONGEST name first, then alphabetical: JS regex alternation is leftmost-first, so
  // ordering longer names before their prefixes makes the match longest-at-position
  // (`postgres pro` wins over `postgres`; codex). Deterministic, so truncation is stable.
  const targetNames = [...nameToId.keys()]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_TARGET_NAMES);
  const pattern = `\\b(?:${targetNames.map(escapeRegex).join('|')})\\b`;
  const re = new RegExp(pattern, 'gi');

  let references = 0;
  for (const src of created) {
    if (src.superseded) continue; // superseded sources hold only stale references (codex)
    if (!src.searchText) continue;
    const targets = new Set<number>();
    for (const m of src.searchText.matchAll(re)) {
      const targetId = nameToId.get(m[0].toLowerCase());
      if (targetId === undefined || targetId === src.entityId) continue; // miss / self
      if (supersededPairs.has(pairKey(src.entityId, targetId))) continue; // already version-related
      targets.add(targetId);
      if (targets.size >= MAX_REFERENCES_PER_OBJECT) break; // per-source cap
    }
    for (const targetId of targets) {
      insertRelation(hippoRoot, tenantId, {
        fromEntityId: src.entityId,
        toEntityId: targetId,
        relType: 'references',
        // Anchored to the source object; its mirror memory is passed only when it lives.
        memoryId: src.memoryId,
        sourceObject: src.sourceObject,
      }, txDb);
      references += 1;
    }
  }
  return references;
}
