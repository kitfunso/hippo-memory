/**
 * E3.3 graph layer over consolidated state - the graph-on-consolidated guard.
 * (docs/plans/2026-06-01-e3-graph-guard.md).
 *
 * A graph of canonical `entities` (person/project/customer/system/policy/decision) and
 * `relations` (owns/supersedes/depends-on/blocked-by/references) sits ON TOP OF
 * consolidated memories. The hard rule: the graph NEVER indexes the raw layer - every
 * entity and relation references a memory whose `kind IN ('distilled','superseded')`,
 * never `kind='raw'`. Enforced at the DB level (CHECK on source_kind/kind + BEFORE
 * INSERT and BEFORE UPDATE triggers that tie source_kind/kind to the FK'd memory's
 * actual kind and enforce tenant-match - relations also reject cross-tenant edges), so
 * the forbidden state is unrepresentable regardless of code path. These helpers
 * surface the same guard as clear throws BEFORE hitting the trigger backstop.
 *
 * Scope (E3.3 first slice): the substrate + the guard + a thin insert/load/enqueue
 * API. The `graph_extraction_queue` is the interface the deferred `hippo sleep`
 * enqueue-hook + E3.1 entity extraction will call. No operator surface (CLI/HTTP/SDK)
 * until E3.2 multi-hop recall.
 */

import { openHippoDb, closeHippoDb } from './db.js';
import { assertTenantId } from './store.js';

/** The DB connection handle `openHippoDb` returns. Threaded (optionally) through
 *  the graph writers so `extractGraph` can run clear + all inserts in ONE
 *  transaction — see `runGraphRebuildTransaction`. */
export type GraphTxDb = ReturnType<typeof openHippoDb>;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type EntityType = 'person' | 'project' | 'customer' | 'system' | 'policy' | 'decision';
export type RelationType = 'owns' | 'supersedes' | 'depends-on' | 'blocked-by' | 'references';
export type GraphQueueStatus = 'pending' | 'processed' | 'skipped';
/** The consolidated source kinds the graph is permitted to index (never 'raw'). */
export type SourceKind = 'distilled' | 'superseded';
/** The authoritative E2 object types a graph row may be anchored to (the object
 *  provenance path, alongside the memory path). Maps to source_object_type. */
export type SourceObjectType = 'decision' | 'policy' | 'customer' | 'project';

/** A soft (type,id) pointer to the authoritative E2 row a graph row descends from.
 *  Survives a mirror memory forget/prune (memory_id may go NULL); the rebuild
 *  re-validates it (it is not a hard FK). */
export interface SourceObjectRef {
  type: SourceObjectType;
  id: number;
}

/** source_object_type -> its E2 table, for the object-path validation 4-way branch.
 *  SQLite cannot parametrize a table name, so the SQL trigger mirrors this explicitly. */
const SOURCE_OBJECT_TABLE: Record<SourceObjectType, string> = {
  decision: 'decisions',
  policy: 'policies',
  customer: 'customer_notes',
  project: 'project_briefs',
};

export const GRAPH_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'person', 'project', 'customer', 'system', 'policy', 'decision',
]);
export const GRAPH_RELATION_TYPES: ReadonlySet<RelationType> = new Set<RelationType>([
  'owns', 'supersedes', 'depends-on', 'blocked-by', 'references',
]);
export const VALID_QUEUE_STATES: ReadonlySet<GraphQueueStatus> = new Set<GraphQueueStatus>([
  'pending', 'processed', 'skipped',
]);

export const MAX_ENTITY_NAME_LEN = 512;

export interface Entity {
  id: number;
  tenantId: string;
  entityType: EntityType;
  name: string;
  /** The consolidated source memory this entity was extracted from. NULL once the
   *  mirror is forgotten/pruned (ON DELETE SET NULL) - the entity then survives via
   *  its source_object provenance. */
  memoryId: string | null;
  sourceKind: SourceKind;
  /** The authoritative E2 object this entity is anchored to (E2-provenance path).
   *  Set for E2-sourced entities; absent for memory-only (prose/NLP) entities. */
  sourceObjectType?: SourceObjectType;
  sourceObjectId?: number;
  createdAt: string;
}

export interface Relation {
  id: number;
  tenantId: string;
  fromEntityId: number;
  toEntityId: number;
  relType: RelationType;
  /** NULL once the mirror is forgotten/pruned; the relation survives via source_object. */
  memoryId: string | null;
  sourceKind: SourceKind;
  sourceObjectType?: SourceObjectType;
  sourceObjectId?: number;
  createdAt: string;
}

export interface GraphQueueItem {
  id: number;
  tenantId: string;
  memoryId: string;
  kind: SourceKind;
  status: GraphQueueStatus;
  enqueuedAt: string;
  processedAt: string | null;
}

export interface InsertEntityOpts {
  entityType: EntityType;
  name: string;
  /** A consolidated (distilled/superseded) memory; raw is rejected. NULL/omitted when
   *  the entity is anchored only to its E2 source object (mirror forgotten/pruned). */
  memoryId?: string | null;
  /** The authoritative E2 object this entity descends from. Required when memoryId is
   *  null; optional alongside a live memory (both paths may be set). */
  sourceObject?: SourceObjectRef;
}

export interface InsertRelationOpts {
  fromEntityId: number;
  toEntityId: number;
  relType: RelationType;
  /** A consolidated (distilled/superseded) memory; raw is rejected. NULL/omitted when
   *  the relation is anchored only to its E2 source object. */
  memoryId?: string | null;
  /** The authoritative E2 object this relation descends from. */
  sourceObject?: SourceObjectRef;
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

interface EntityRow {
  id: number;
  tenant_id: string;
  entity_type: string;
  name: string;
  memory_id: string | null;
  source_kind: string;
  source_object_type: string | null;
  source_object_id: number | null;
  created_at: string;
}
interface RelationRow {
  id: number;
  tenant_id: string;
  from_entity_id: number;
  to_entity_id: number;
  rel_type: string;
  memory_id: string | null;
  source_kind: string;
  source_object_type: string | null;
  source_object_id: number | null;
  created_at: string;
}
interface QueueRow {
  id: number;
  tenant_id: string;
  memory_id: string;
  kind: string;
  status: string;
  enqueued_at: string;
  processed_at: string | null;
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    entityType: row.entity_type as EntityType,
    name: row.name,
    memoryId: row.memory_id,
    sourceKind: row.source_kind as SourceKind,
    sourceObjectType: row.source_object_type === null ? undefined : (row.source_object_type as SourceObjectType),
    sourceObjectId: row.source_object_id === null ? undefined : row.source_object_id,
    createdAt: row.created_at,
  };
}
function rowToRelation(row: RelationRow): Relation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    relType: row.rel_type as RelationType,
    memoryId: row.memory_id,
    sourceKind: row.source_kind as SourceKind,
    sourceObjectType: row.source_object_type === null ? undefined : (row.source_object_type as SourceObjectType),
    sourceObjectId: row.source_object_id === null ? undefined : row.source_object_id,
    createdAt: row.created_at,
  };
}
function rowToQueueItem(row: QueueRow): GraphQueueItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    memoryId: row.memory_id,
    kind: row.kind as SourceKind,
    status: row.status as GraphQueueStatus,
    enqueuedAt: row.enqueued_at,
    processedAt: row.processed_at,
  };
}

const ENTITY_COLS = `id, tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at`;
const RELATION_COLS = `id, tenant_id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, source_object_type, source_object_id, created_at`;
const QUEUE_COLS = `id, tenant_id, memory_id, kind, status, enqueued_at, processed_at`;

// ---------------------------------------------------------------------------
// Guard helper: resolve a consolidated source memory or throw
// ---------------------------------------------------------------------------

interface DbLike {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * Resolve the `source_kind` for a graph row from AT LEAST ONE valid provenance path,
 * with the no-raw invariant intact. The code-level mirror of the DB trigger guard (the
 * trigger is the unbypassable backstop). Two paths:
 *  - MEMORY path (`memoryId` not null): the memory must exist, be same-tenant, and be
 *    consolidated (distilled/superseded); raw is rejected. Returns its kind.
 *  - OBJECT path (`memoryId` null, `sourceObject` set): the E2 row must exist, be
 *    same-tenant, and have status active|superseded (4-way per E2 table). E2 objects are
 *    consolidated BY CONSTRUCTION, so this returns 'distilled'.
 * All-null (no memory AND no source object) is rejected.
 */
function resolveConsolidatedSource(
  db: DbLike,
  tenantId: string,
  memoryId: string | null,
  sourceObject: SourceObjectRef | null,
  label: string,
): { sourceKind: SourceKind; memoryId: string | null } {
  let memKind: SourceKind | null = null;
  let effectiveMemoryId: string | null = memoryId;
  if (memoryId != null) {
    const row = db.prepare(`SELECT kind, tenant_id FROM memories WHERE id = ?`).get(memoryId) as
      | { kind: string; tenant_id: string }
      | undefined;
    if (!row) {
      // Stale / forgotten mirror. Tolerate it IFF a valid source object provides provenance:
      // graph-extract reads E2 rows then inserts, and a mirror forgotten/pruned in that window
      // must NOT roll back the whole tenant rebuild - the active E2 object survives mirror loss
      // (v38 contract; codex round-4 race). Anchor to the object; drop the dead memory pointer.
      if (sourceObject == null) {
        throw new Error(`${label}: source memory ${memoryId} not found`);
      }
      effectiveMemoryId = null;
    } else if (row.tenant_id !== tenantId) {
      throw new Error(`${label}: source memory ${memoryId} belongs to another tenant`);
    } else if (row.kind === 'raw') {
      throw new Error(`${label}: source memory ${memoryId} is raw; the graph indexes consolidated state only`);
    } else if (row.kind !== 'distilled' && row.kind !== 'superseded') {
      throw new Error(`${label}: source memory ${memoryId} has unsupported kind '${row.kind}'`);
    } else {
      memKind = row.kind;
    }
  }

  // Validate the object pointer WHENEVER it is provided - not only when memory is null
  // (codex review): a dual-set row whose object is wrong/closed/cross-tenant would become
  // the active provenance after ON DELETE SET NULL and could then block the memory delete.
  if (sourceObject != null) {
    const table = SOURCE_OBJECT_TABLE[sourceObject.type];
    if (!table) {
      throw new Error(`${label}: unsupported source_object_type '${sourceObject.type}'`);
    }
    // `table` is a fixed value from the SOURCE_OBJECT_TABLE map (never user-supplied), so
    // this string interpolation is safe; `id`/`tenant_id` stay parametrized.
    const row = db.prepare(
      `SELECT status FROM ${table} WHERE id = ? AND tenant_id = ?`,
    ).get(sourceObject.id, tenantId) as { status: string } | undefined;
    if (!row) {
      throw new Error(`${label}: source ${sourceObject.type} ${sourceObject.id} not found for tenant ${tenantId}`);
    }
    if (row.status !== 'active' && row.status !== 'superseded') {
      throw new Error(`${label}: source ${sourceObject.type} ${sourceObject.id} has status '${row.status}' (must be active|superseded)`);
    }
  }

  // source_kind is the memory's kind when a memory is present, else 'distilled' for an
  // object-only row (E2 objects are consolidated by construction). All-null is rejected.
  if (memKind != null) return { sourceKind: memKind, memoryId: effectiveMemoryId };
  if (sourceObject != null) return { sourceKind: 'distilled', memoryId: null };
  throw new Error(`${label}: graph row needs a memory or a source object`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a graph entity extracted from a consolidated memory. Throws if the source
 * memory is missing / cross-tenant / raw (the DB trigger is the backstop).
 */
export function insertEntity(
  hippoRoot: string,
  tenantId: string,
  opts: InsertEntityOpts,
  txDb?: GraphTxDb,
): Entity {
  assertTenantId('insertEntity', tenantId);
  if (!GRAPH_ENTITY_TYPES.has(opts.entityType)) {
    throw new Error(`insertEntity: entityType must be one of ${Array.from(GRAPH_ENTITY_TYPES).join('|')}; got ${opts.entityType}`);
  }
  const name = (opts.name ?? '').trim();
  if (name.length === 0) throw new Error('insertEntity: name is required');
  if (name.length > MAX_ENTITY_NAME_LEN) {
    throw new Error(`insertEntity: name exceeds the ${MAX_ENTITY_NAME_LEN}-char cap`);
  }
  const now = new Date().toISOString();
  const memoryId = opts.memoryId ?? null;
  const sourceObject = opts.sourceObject ?? null;
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    const { sourceKind, memoryId: effectiveMemoryId } = resolveConsolidatedSource(db, tenantId, memoryId, sourceObject, 'insertEntity');
    const result = db.prepare(`
      INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tenantId, opts.entityType, name, effectiveMemoryId, sourceKind, sourceObject?.type ?? null, sourceObject?.id ?? null, now);
    const id = Number(result.lastInsertRowid ?? 0);
    const row = db.prepare(`SELECT ${ENTITY_COLS} FROM entities WHERE id = ?`).get(id) as EntityRow | undefined;
    if (!row) throw new Error('insertEntity: failed to reload inserted entity');
    return rowToEntity(row);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

/**
 * Insert a graph relation between two entities, sourced from a consolidated memory.
 * Both entities must exist in the same tenant; the source memory must be consolidated.
 */
export function insertRelation(
  hippoRoot: string,
  tenantId: string,
  opts: InsertRelationOpts,
  txDb?: GraphTxDb,
): Relation {
  assertTenantId('insertRelation', tenantId);
  if (!GRAPH_RELATION_TYPES.has(opts.relType)) {
    throw new Error(`insertRelation: relType must be one of ${Array.from(GRAPH_RELATION_TYPES).join('|')}; got ${opts.relType}`);
  }
  const now = new Date().toISOString();
  const memoryId = opts.memoryId ?? null;
  const sourceObject = opts.sourceObject ?? null;
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    for (const [eid, role] of [[opts.fromEntityId, 'from'], [opts.toEntityId, 'to']] as const) {
      const ent = db.prepare(`SELECT tenant_id FROM entities WHERE id = ?`).get(eid) as { tenant_id: string } | undefined;
      if (!ent) throw new Error(`insertRelation: ${role}_entity ${eid} not found`);
      if (ent.tenant_id !== tenantId) {
        throw new Error(`insertRelation: ${role}_entity ${eid} belongs to another tenant (no cross-tenant edges)`);
      }
    }
    const { sourceKind, memoryId: effectiveMemoryId } = resolveConsolidatedSource(db, tenantId, memoryId, sourceObject, 'insertRelation');
    const result = db.prepare(`
      INSERT INTO relations(tenant_id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, source_object_type, source_object_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tenantId, opts.fromEntityId, opts.toEntityId, opts.relType, effectiveMemoryId, sourceKind, sourceObject?.type ?? null, sourceObject?.id ?? null, now);
    const id = Number(result.lastInsertRowid ?? 0);
    const row = db.prepare(`SELECT ${RELATION_COLS} FROM relations WHERE id = ?`).get(id) as RelationRow | undefined;
    if (!row) throw new Error('insertRelation: failed to reload inserted relation');
    return rowToRelation(row);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

export function loadEntityById(hippoRoot: string, tenantId: string, id: number): Entity | null {
  assertTenantId('loadEntityById', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`SELECT ${ENTITY_COLS} FROM entities WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

/** Entities with an exact `name` (read), bounded by `limit` in SQL with a
 *  deterministic order. Lets the graph-view focus query find the `--entity NAME`
 *  entity DIRECTLY (not from a globally-capped list) WITHOUT materializing every
 *  same-name row when a name maps to many entities. */
export function loadEntitiesByName(
  hippoRoot: string,
  tenantId: string,
  name: string,
  opts: { limit?: number } = {},
  txDb?: GraphTxDb,
): Entity[] {
  assertTenantId('loadEntitiesByName', tenantId);
  const limit = opts.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`loadEntitiesByName: limit must be a non-negative integer; got ${limit}`);
  }
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    const rows = db.prepare(`
      SELECT ${ENTITY_COLS} FROM entities WHERE tenant_id = ? AND name = ?
      ORDER BY id ASC LIMIT ?
    `).all(tenantId, name, limit) as EntityRow[];
    return rows.map(rowToEntity);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

export function loadEntities(
  hippoRoot: string,
  tenantId: string,
  opts: { entityType?: EntityType; limit?: number } = {},
  txDb?: GraphTxDb,
): Entity[] {
  assertTenantId('loadEntities', tenantId);
  const limit = opts.limit ?? 100;
  if (opts.entityType && !GRAPH_ENTITY_TYPES.has(opts.entityType)) {
    throw new Error(`loadEntities: entityType must be one of ${Array.from(GRAPH_ENTITY_TYPES).join('|')}; got ${opts.entityType}`);
  }
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    const clauses = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (opts.entityType) {
      clauses.push('entity_type = ?');
      params.push(opts.entityType);
    }
    params.push(limit);
    const rows = db.prepare(`
      SELECT ${ENTITY_COLS} FROM entities
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params) as EntityRow[];
    return rows.map(rowToEntity);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

export function loadRelations(
  hippoRoot: string,
  tenantId: string,
  opts: { fromEntityId?: number; limit?: number } = {},
  txDb?: GraphTxDb,
): Relation[] {
  assertTenantId('loadRelations', tenantId);
  const limit = opts.limit ?? 100;
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    const clauses = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (opts.fromEntityId !== undefined) {
      clauses.push('from_entity_id = ?');
      params.push(opts.fromEntityId);
    }
    params.push(limit);
    const rows = db.prepare(`
      SELECT ${RELATION_COLS} FROM relations
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params) as RelationRow[];
    return rows.map(rowToRelation);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

// ---------------------------------------------------------------------------
// E3.2 multi-hop recall read helpers (SELECT-only; the check-graph-writes lint
// permits these here and in the read-only consumer src/graph-recall.ts).
// ---------------------------------------------------------------------------

/** Chunk size for IN-list queries: well under SQLite's 999-bound-variable default
 *  (leaves headroom for the tenant_id param + the doubled list in neighbour lookups). */
const IN_LIST_CHUNK = 400;

/**
 * Map consolidated source memory ids -> their graph entities. The SEED step of E3.2
 * multi-hop recall (recall result memory ids -> entities to traverse from). Tenant-
 * scoped, read-only; chunks the IN-list under the SQLite variable cap.
 */
export function loadEntitiesByMemoryId(
  hippoRoot: string,
  tenantId: string,
  memoryIds: string[],
): Entity[] {
  assertTenantId('loadEntitiesByMemoryId', tenantId);
  if (memoryIds.length === 0) return [];
  const db = openHippoDb(hippoRoot);
  try {
    const out: Entity[] = [];
    for (let i = 0; i < memoryIds.length; i += IN_LIST_CHUNK) {
      const slice = memoryIds.slice(i, i + IN_LIST_CHUNK);
      const ph = slice.map(() => '?').join(',');
      // T2: no ORDER BY meant chunk-local scan order decided ties; id ASC
      // makes it deterministic (entities.id is an autoincrement integer PK).
      const rows = db.prepare(`
        SELECT ${ENTITY_COLS} FROM entities
        WHERE tenant_id = ? AND memory_id IN (${ph})
        ORDER BY id ASC
      `).all(tenantId, ...slice) as EntityRow[];
      out.push(...rows.map(rowToEntity));
    }
    return out;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Load entities by their primary ids. Resolves the entity rows reached during the BFS
 * (whose `memory_id` maps back to a recall result). Tenant-scoped, read-only.
 */
export function loadEntitiesByIds(
  hippoRoot: string,
  tenantId: string,
  ids: number[],
  txDb?: GraphTxDb,
): Entity[] {
  assertTenantId('loadEntitiesByIds', tenantId);
  if (ids.length === 0) return [];
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    const out: Entity[] = [];
    for (let i = 0; i < ids.length; i += IN_LIST_CHUNK) {
      const slice = ids.slice(i, i + IN_LIST_CHUNK);
      const ph = slice.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT ${ENTITY_COLS} FROM entities
        WHERE tenant_id = ? AND id IN (${ph})
      `).all(tenantId, ...slice) as EntityRow[];
      out.push(...rows.map(rowToEntity));
    }
    return out;
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

/**
 * All relations touching ANY of `entityIds` in EITHER direction (from OR to) — the
 * per-hop neighbour query for E3.2 multi-hop traversal. ONE query for the whole frontier
 * (not one per node): this is the bidirectional read `loadRelations` (from-only) lacks,
 * and avoids an N+1 across BFS frontier nodes. `limit` caps rows for the frontier and
 * must be a non-negative integer (the raw `LIMIT ?` rejects a fractional value).
 */
export function loadNeighborRelations(
  hippoRoot: string,
  tenantId: string,
  entityIds: number[],
  opts: { limit?: number } = {},
  txDb?: GraphTxDb,
): Relation[] {
  assertTenantId('loadNeighborRelations', tenantId);
  if (entityIds.length === 0) return [];
  const limit = opts.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`loadNeighborRelations: limit must be a non-negative integer; got ${limit}`);
  }
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    // `limit` is applied PER CHUNK; a frontier spanning >IN_LIST_CHUNK ids could return
    // up to limit*chunks rows before the by-id dedup below. Harmless for E3.2 (the
    // frontier is bounded by maxNeighbors <= 200 << IN_LIST_CHUNK, so a single chunk,
    // and the BFS re-enforces the per-hop fanout cap), but note the semantics if a
    // tighter total cap is ever needed.
    const byId = new Map<number, Relation>();
    for (let i = 0; i < entityIds.length; i += IN_LIST_CHUNK) {
      const slice = entityIds.slice(i, i + IN_LIST_CHUNK);
      const ph = slice.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT ${RELATION_COLS} FROM relations
        WHERE tenant_id = ? AND (from_entity_id IN (${ph}) OR to_entity_id IN (${ph}))
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, ...slice, ...slice, limit) as RelationRow[];
      for (const r of rows) byId.set(r.id, rowToRelation(r));
    }
    return Array.from(byId.values());
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

/**
 * Relations with BOTH endpoints in `entityIds` (edges AMONG the set, not merely
 * touching it). Read. Used by the graph-view focus subgraph so the displayed
 * edges are exactly the intra-union edges: the `LIMIT` only caps genuinely-many
 * intra-union edges — no out-of-union row can evict a valid in-set edge. The
 * caller bounds `entityIds` (<= the view limit), so a single query is safe.
 */
export function loadRelationsAmong(
  hippoRoot: string,
  tenantId: string,
  entityIds: number[],
  opts: { limit?: number } = {},
  txDb?: GraphTxDb,
): Relation[] {
  assertTenantId('loadRelationsAmong', tenantId);
  if (entityIds.length === 0) return [];
  const limit = opts.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`loadRelationsAmong: limit must be a non-negative integer; got ${limit}`);
  }
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    const ph = entityIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT ${RELATION_COLS} FROM relations
      WHERE tenant_id = ? AND from_entity_id IN (${ph}) AND to_entity_id IN (${ph})
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(tenantId, ...entityIds, ...entityIds, limit) as RelationRow[];
    return rows.map(rowToRelation);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

/**
 * Run `fn` inside ONE read transaction (a single WAL snapshot) so every graph read
 * it performs — pass the supplied `txDb` to the `load*` functions — sees a consistent
 * view, even if a `graph extract` / sleep-drain rebuild commits concurrently between
 * reads (the rebuild clears + reinserts entities, so separate reads could otherwise
 * mix old entity ids with new relation ids). Reads only; the connection is opened
 * once and closed after.
 */
export function withGraphReadSnapshot<T>(
  hippoRoot: string,
  fn: (txDb: GraphTxDb) => T,
): T {
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN');
    try {
      const out = fn(db);
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// Extraction queue (the interface the deferred sleep enqueue-hook + E3.1 will use)
// ---------------------------------------------------------------------------

/**
 * Enqueue a consolidated memory for later graph extraction. Rejects a raw / missing /
 * cross-tenant memory (the DB trigger is the backstop). The producer hook in
 * `hippo sleep` is deferred (E3.1); this is the API it will call.
 */
export function enqueueExtraction(
  hippoRoot: string,
  tenantId: string,
  memoryId: string,
): GraphQueueItem {
  assertTenantId('enqueueExtraction', tenantId);
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    // enqueue is memory-keyed (no source object), so a missing memory still throws (correct -
    // you cannot enqueue a forgotten mirror); memoryId is non-null here by construction.
    const { sourceKind } = resolveConsolidatedSource(db, tenantId, memoryId, null, 'enqueueExtraction');
    const result = db.prepare(`
      INSERT INTO graph_extraction_queue(tenant_id, memory_id, kind, status, enqueued_at, processed_at)
      VALUES (?, ?, ?, 'pending', ?, NULL)
    `).run(tenantId, memoryId, sourceKind, now);
    const id = Number(result.lastInsertRowid ?? 0);
    const row = db.prepare(`SELECT ${QUEUE_COLS} FROM graph_extraction_queue WHERE id = ?`).get(id) as QueueRow | undefined;
    if (!row) throw new Error('enqueueExtraction: failed to reload queue item');
    return rowToQueueItem(row);
  } finally {
    closeHippoDb(db);
  }
}

export function loadExtractionQueue(
  hippoRoot: string,
  tenantId: string,
  opts: { status?: GraphQueueStatus; limit?: number } = {},
): GraphQueueItem[] {
  assertTenantId('loadExtractionQueue', tenantId);
  const limit = opts.limit ?? 100;
  if (opts.status && !VALID_QUEUE_STATES.has(opts.status)) {
    throw new Error(`loadExtractionQueue: status must be one of ${Array.from(VALID_QUEUE_STATES).join('|')}; got ${opts.status}`);
  }
  const db = openHippoDb(hippoRoot);
  try {
    const clauses = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    params.push(limit);
    const rows = db.prepare(`
      SELECT ${QUEUE_COLS} FROM graph_extraction_queue
      WHERE ${clauses.join(' AND ')}
      ORDER BY enqueued_at ASC, id ASC
      LIMIT ?
    `).all(...params) as QueueRow[];
    return rows.map(rowToQueueItem);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Mark a queue item terminal (processed | skipped). Only `status`/`processed_at`
 * change, so the consolidated-source guard trigger (which fires on
 * memory_id/kind/tenant_id changes) is not involved. CAS on the current status to a
 * non-terminal 'pending'.
 */
export function markExtractionProcessed(
  hippoRoot: string,
  tenantId: string,
  id: number,
  status: 'processed' | 'skipped' = 'processed',
): GraphQueueItem {
  assertTenantId('markExtractionProcessed', tenantId);
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    const updated = db.prepare(`
      UPDATE graph_extraction_queue
      SET status = ?, processed_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'pending'
    `).run(status, now, id, tenantId);
    if (updated.changes === 0) {
      const existing = db.prepare(`SELECT status FROM graph_extraction_queue WHERE id = ? AND tenant_id = ?`)
        .get(id, tenantId) as { status: string } | undefined;
      if (!existing) throw new Error(`markExtractionProcessed: queue item ${id} not found for tenant ${tenantId}`);
      throw new Error(`markExtractionProcessed: queue item ${id} is not pending (status='${existing.status}')`);
    }
    const row = db.prepare(`SELECT ${QUEUE_COLS} FROM graph_extraction_queue WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as QueueRow | undefined;
    if (!row) throw new Error(`markExtractionProcessed: queue item ${id} not found after UPDATE`);
    return rowToQueueItem(row);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Delete ALL entities for a tenant (relations cascade via the from/to FKs). Returns
 * the number of entities deleted. The rebuild primitive for graph extraction: the
 * deterministic graph is a pure derived function of the consolidated objects, so an
 * extract clears then re-derives. Lives in graph.ts (the sole sanctioned graph
 * writer), so the E3.3 CI lint permits this `DELETE FROM entities`. Does NOT touch
 * graph_extraction_queue (the enqueue-hook's domain).
 */
export function clearGraph(hippoRoot: string, tenantId: string, txDb?: GraphTxDb): number {
  assertTenantId('clearGraph', tenantId);
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    const res = db.prepare(`DELETE FROM entities WHERE tenant_id = ?`).run(tenantId);
    return Number(res.changes ?? 0);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

/**
 * Run a full graph rebuild for one tenant inside a single transaction. `clearGraph`
 * + every `insertEntity`/`insertRelation` call made inside `fn` (passing the supplied
 * `txDb`) share the one connection and its `BEGIN IMMEDIATE` write lock, so the
 * rebuild is ATOMIC: two concurrent rebuilds serialize on the write lock (the second
 * waits, then re-derives cleanly) instead of interleaving into duplicate rows, and a
 * throw mid-rebuild ROLLS BACK the clear (no bricked/empty graph). The sole sanctioned
 * place to wrap graph writes in a transaction.
 */
export function runGraphRebuildTransaction<T>(
  hippoRoot: string,
  tenantId: string,
  fn: (txDb: GraphTxDb) => T,
): T {
  assertTenantId('runGraphRebuildTransaction', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const out = fn(db);
      db.exec('COMMIT');
      committed = true;
      return out;
    } finally {
      if (!committed) {
        try { db.exec('ROLLBACK'); } catch { /* preserve the original throw */ }
      }
    }
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// E3 sleep enqueue-hook — producer helper + drain support
// ---------------------------------------------------------------------------

/**
 * Fail-soft producer hook: mark a tenant dirty for graph re-extraction by
 * enqueuing its consolidated mirror memory. NEVER throws into the caller — a
 * graph-dirty signal failing must not abort a core E2 write. Graph staleness is
 * recoverable (next sleep / manual `graph extract`); a broken `hippo decide` is
 * not. Called POST-COMMIT from the E2 graph-source save/close mutations of
 * decision, policy, customer_note and project_brief. A null memoryId (a
 * forgotten mirror) is a no-op.
 */
export function markGraphDirty(hippoRoot: string, tenantId: string, memoryId: string | null): void {
  if (!memoryId) return;
  try {
    enqueueExtraction(hippoRoot, tenantId, memoryId);
  } catch (err) {
    // Logged (warn) so a SYSTEMATIC enqueue failure surfaces to operators, but
    // swallowed so the already-committed E2 write is never rolled back.
    console.warn(
      `markGraphDirty: enqueue failed for tenant=${tenantId} memory=${memoryId}: ${(err as Error).message}`,
    );
  }
}

/**
 * Remove the graph rows sourced from one E2 object, by its (type, id). Used when a
 * MIRRORLESS object is closed: it has no mirror memory, so `markGraphDirty` cannot
 * enqueue a rebuild (the queue is memory-keyed). Closing must still drop the object's
 * now-stale entity + edges from the graph, so we remove them directly here. Fail-soft
 * like `markGraphDirty` (never throws into the E2 close caller; graph staleness is
 * recoverable). Deleting the entity cascade-deletes any relation where it is an endpoint
 * (relations FK entities ON DELETE CASCADE); the explicit relations DELETE also covers a
 * relation whose OWN provenance is this object (defensive — every such edge has the object
 * as an endpoint today, so the cascade already covers it). DELETE fires no BEFORE
 * INSERT/UPDATE guard trigger.
 */
export function removeGraphEntitiesForObject(
  hippoRoot: string,
  tenantId: string,
  sourceObjectType: SourceObjectType,
  sourceObjectId: number,
): void {
  try {
    assertTenantId('removeGraphEntitiesForObject', tenantId);
    const db = openHippoDb(hippoRoot);
    try {
      db.exec('BEGIN');
      db.prepare(`DELETE FROM relations WHERE tenant_id = ? AND source_object_type = ? AND source_object_id = ?`)
        .run(tenantId, sourceObjectType, sourceObjectId);
      db.prepare(`DELETE FROM entities WHERE tenant_id = ? AND source_object_type = ? AND source_object_id = ?`)
        .run(tenantId, sourceObjectType, sourceObjectId);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original throw */ }
      throw e;
    } finally {
      closeHippoDb(db);
    }
  } catch (err) {
    console.warn(
      `removeGraphEntitiesForObject: failed for tenant=${tenantId} ${sourceObjectType}#${sourceObjectId}: ${(err as Error).message}`,
    );
  }
}

/**
 * The dirty tenants awaiting graph re-extraction, each with the MAX pending
 * queue id at read time (a watermark). The sleep drain rebuilds each tenant's
 * graph, then marks only items at or below the watermark processed, so items
 * enqueued DURING the rebuild stay pending for the next sleep (no lost-update
 * race). Host-wide read (the queue is per-tenant but sleep is cross-tenant).
 */
export function loadPendingExtractionTenants(
  hippoRoot: string,
): { tenantId: string; maxPendingId: number }[] {
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT tenant_id AS tenant_id, MAX(id) AS max_id
      FROM graph_extraction_queue
      WHERE status = 'pending'
      GROUP BY tenant_id
    `).all() as { tenant_id: string; max_id: number }[];
    return rows.map((r) => ({ tenantId: r.tenant_id, maxPendingId: Number(r.max_id) }));
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Mark every pending queue item for a tenant with `id <= maxId` processed, in
 * one UPDATE. Status/processed_at only, so the consolidated-source guard trigger
 * is not involved (same as markExtractionProcessed). Returns the count marked.
 * The `<= maxId` watermark excludes items enqueued after the drain snapshot.
 */
export function markPendingProcessedUpTo(
  hippoRoot: string,
  tenantId: string,
  maxId: number,
): number {
  assertTenantId('markPendingProcessedUpTo', tenantId);
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    const res = db.prepare(`
      UPDATE graph_extraction_queue
      SET status = 'processed', processed_at = ?
      WHERE tenant_id = ? AND status = 'pending' AND id <= ?
    `).run(now, tenantId, maxId);
    return Number(res.changes ?? 0);
  } finally {
    closeHippoDb(db);
  }
}
