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

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type EntityType = 'person' | 'project' | 'customer' | 'system' | 'policy' | 'decision';
export type RelationType = 'owns' | 'supersedes' | 'depends-on' | 'blocked-by' | 'references';
export type GraphQueueStatus = 'pending' | 'processed' | 'skipped';
/** The consolidated source kinds the graph is permitted to index (never 'raw'). */
export type SourceKind = 'distilled' | 'superseded';

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
  /** The consolidated source memory this entity was extracted from. */
  memoryId: string;
  sourceKind: SourceKind;
  createdAt: string;
}

export interface Relation {
  id: number;
  tenantId: string;
  fromEntityId: number;
  toEntityId: number;
  relType: RelationType;
  memoryId: string;
  sourceKind: SourceKind;
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
  /** A consolidated (distilled/superseded) memory; raw is rejected. */
  memoryId: string;
}

export interface InsertRelationOpts {
  fromEntityId: number;
  toEntityId: number;
  relType: RelationType;
  /** A consolidated (distilled/superseded) memory; raw is rejected. */
  memoryId: string;
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

interface EntityRow {
  id: number;
  tenant_id: string;
  entity_type: string;
  name: string;
  memory_id: string;
  source_kind: string;
  created_at: string;
}
interface RelationRow {
  id: number;
  tenant_id: string;
  from_entity_id: number;
  to_entity_id: number;
  rel_type: string;
  memory_id: string;
  source_kind: string;
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

const ENTITY_COLS = `id, tenant_id, entity_type, name, memory_id, source_kind, created_at`;
const RELATION_COLS = `id, tenant_id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, created_at`;
const QUEUE_COLS = `id, tenant_id, memory_id, kind, status, enqueued_at, processed_at`;

// ---------------------------------------------------------------------------
// Guard helper: resolve a consolidated source memory or throw
// ---------------------------------------------------------------------------

interface DbLike {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * Look up a memory and assert it is a valid CONSOLIDATED source for the graph: it
 * exists, belongs to `tenantId`, and is not raw. Returns its kind (the source_kind to
 * store). Throws a clear error otherwise. This is the code-level mirror of the DB
 * trigger guard (which is the unbypassable backstop).
 */
function resolveConsolidatedSource(db: DbLike, tenantId: string, memoryId: string, label: string): SourceKind {
  const row = db.prepare(`SELECT kind, tenant_id FROM memories WHERE id = ?`).get(memoryId) as
    | { kind: string; tenant_id: string }
    | undefined;
  if (!row) {
    throw new Error(`${label}: source memory ${memoryId} not found`);
  }
  if (row.tenant_id !== tenantId) {
    throw new Error(`${label}: source memory ${memoryId} belongs to another tenant`);
  }
  if (row.kind === 'raw') {
    throw new Error(`${label}: source memory ${memoryId} is raw; the graph indexes consolidated state only`);
  }
  if (row.kind !== 'distilled' && row.kind !== 'superseded') {
    throw new Error(`${label}: source memory ${memoryId} has unsupported kind '${row.kind}'`);
  }
  return row.kind;
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
  const db = openHippoDb(hippoRoot);
  try {
    const sourceKind = resolveConsolidatedSource(db, tenantId, opts.memoryId, 'insertEntity');
    const result = db.prepare(`
      INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tenantId, opts.entityType, name, opts.memoryId, sourceKind, now);
    const id = Number(result.lastInsertRowid ?? 0);
    const row = db.prepare(`SELECT ${ENTITY_COLS} FROM entities WHERE id = ?`).get(id) as EntityRow | undefined;
    if (!row) throw new Error('insertEntity: failed to reload inserted entity');
    return rowToEntity(row);
  } finally {
    closeHippoDb(db);
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
): Relation {
  assertTenantId('insertRelation', tenantId);
  if (!GRAPH_RELATION_TYPES.has(opts.relType)) {
    throw new Error(`insertRelation: relType must be one of ${Array.from(GRAPH_RELATION_TYPES).join('|')}; got ${opts.relType}`);
  }
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    for (const [eid, role] of [[opts.fromEntityId, 'from'], [opts.toEntityId, 'to']] as const) {
      const ent = db.prepare(`SELECT tenant_id FROM entities WHERE id = ?`).get(eid) as { tenant_id: string } | undefined;
      if (!ent) throw new Error(`insertRelation: ${role}_entity ${eid} not found`);
      if (ent.tenant_id !== tenantId) {
        throw new Error(`insertRelation: ${role}_entity ${eid} belongs to another tenant (no cross-tenant edges)`);
      }
    }
    const sourceKind = resolveConsolidatedSource(db, tenantId, opts.memoryId, 'insertRelation');
    const result = db.prepare(`
      INSERT INTO relations(tenant_id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(tenantId, opts.fromEntityId, opts.toEntityId, opts.relType, opts.memoryId, sourceKind, now);
    const id = Number(result.lastInsertRowid ?? 0);
    const row = db.prepare(`SELECT ${RELATION_COLS} FROM relations WHERE id = ?`).get(id) as RelationRow | undefined;
    if (!row) throw new Error('insertRelation: failed to reload inserted relation');
    return rowToRelation(row);
  } finally {
    closeHippoDb(db);
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

export function loadEntities(
  hippoRoot: string,
  tenantId: string,
  opts: { entityType?: EntityType; limit?: number } = {},
): Entity[] {
  assertTenantId('loadEntities', tenantId);
  const limit = opts.limit ?? 100;
  if (opts.entityType && !GRAPH_ENTITY_TYPES.has(opts.entityType)) {
    throw new Error(`loadEntities: entityType must be one of ${Array.from(GRAPH_ENTITY_TYPES).join('|')}; got ${opts.entityType}`);
  }
  const db = openHippoDb(hippoRoot);
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
    closeHippoDb(db);
  }
}

export function loadRelations(
  hippoRoot: string,
  tenantId: string,
  opts: { fromEntityId?: number; limit?: number } = {},
): Relation[] {
  assertTenantId('loadRelations', tenantId);
  const limit = opts.limit ?? 100;
  const db = openHippoDb(hippoRoot);
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
    closeHippoDb(db);
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
      const rows = db.prepare(`
        SELECT ${ENTITY_COLS} FROM entities
        WHERE tenant_id = ? AND memory_id IN (${ph})
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
): Entity[] {
  assertTenantId('loadEntitiesByIds', tenantId);
  if (ids.length === 0) return [];
  const db = openHippoDb(hippoRoot);
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
    closeHippoDb(db);
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
): Relation[] {
  assertTenantId('loadNeighborRelations', tenantId);
  if (entityIds.length === 0) return [];
  const limit = opts.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`loadNeighborRelations: limit must be a non-negative integer; got ${limit}`);
  }
  const db = openHippoDb(hippoRoot);
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
    const kind = resolveConsolidatedSource(db, tenantId, memoryId, 'enqueueExtraction');
    const result = db.prepare(`
      INSERT INTO graph_extraction_queue(tenant_id, memory_id, kind, status, enqueued_at, processed_at)
      VALUES (?, ?, ?, 'pending', ?, NULL)
    `).run(tenantId, memoryId, kind, now);
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
export function clearGraph(hippoRoot: string, tenantId: string): number {
  assertTenantId('clearGraph', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    const res = db.prepare(`DELETE FROM entities WHERE tenant_id = ?`).run(tenantId);
    return Number(res.changes ?? 0);
  } finally {
    closeHippoDb(db);
  }
}
