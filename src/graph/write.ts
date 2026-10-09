/**
 * Graph layer over consolidated state - the graph-on-consolidated guard.
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
 */

import { openHippoDb, closeHippoDb, withWriteScope } from '../db.js';
import { assertTenantId } from '../tenant.js';
import { errorMessage, log } from '../log.js';
import { clock } from '../write-budget.js';
import { type GraphTxDb, type SourceKind, type SourceObjectType, type SourceObjectRef, GRAPH_ENTITY_TYPES, GRAPH_RELATION_TYPES, MAX_ENTITY_NAME_LEN, type Entity, type Relation, type GraphQueueItem, type InsertEntityOpts, type InsertRelationOpts, type UpdateEntityOpts } from './types.js';
import { type EntityRow, type RelationRow, type QueueRow, rowToEntity, rowToRelation, rowToQueueItem, ENTITY_COLS, RELATION_COLS, QUEUE_COLS, type DbLike } from './rows.js';
import type { DesiredRelation, GraphOp, NaturalKey } from './delta.js';

/** source_object_type -> its object table, for the object-path validation 4-way branch.
 *  SQLite cannot parametrize a table name, so the SQL trigger mirrors this explicitly. */
interface SourceObjectTableMap {
  decision: string;
  policy: string;
  customer: string;
  project: string;
}
const SOURCE_OBJECT_TABLE: SourceObjectTableMap = {
  decision: 'decisions',
  policy: 'policies',
  customer: 'customer_notes',
  project: 'project_briefs',
};

/**
 * Resolve the `source_kind` for a graph row from AT LEAST ONE valid provenance path,
 * with the no-raw invariant intact. The code-level mirror of the DB trigger guard (the
 * trigger is the unbypassable backstop). Two paths:
 *  - MEMORY path (`memoryId` not null): the memory must exist, be same-tenant, and be
 *    consolidated (distilled/superseded); raw is rejected. Returns its kind.
 *  - OBJECT path (`memoryId` null, `sourceObject` set): the object row must exist, be
 *    same-tenant, and have status active|superseded (4-way per object table). Objects are
 *    consolidated BY CONSTRUCTION, so this returns 'distilled'.
 * All-null (no memory AND no source object) is rejected.
 */
interface ResolvedGraphSource {
  sourceKind: SourceKind;
  memoryId: string | null;
}
function resolveConsolidatedSource(
  db: DbLike,
  tenantId: string,
  memoryId: string | null,
  sourceObject: SourceObjectRef | null,
  label: string,
): ResolvedGraphSource {
  let memKind: SourceKind | null = null;
  let effectiveMemoryId: string | null = memoryId;
  if (memoryId != null) {
    // SAFETY: row's shape matches the two columns (kind, tenant_id) named in
    // the SELECT above.
    const row = db.prepare(`SELECT kind, tenant_id FROM memories WHERE id = ?`).get(memoryId) as
      | { kind: string; tenant_id: string }
      | undefined;
    if (!row) {
      // Stale / forgotten mirror. Tolerate it IFF a valid source object provides provenance:
      // graph-extract reads object rows then inserts, and a mirror forgotten/pruned in that window
      // must NOT roll back the whole tenant rebuild - the active object survives mirror loss.
      // Anchor to the object; drop the dead memory pointer.
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

  // Validate the object pointer WHENEVER it is provided, not only when memory is null:
  // a dual-set row whose object is wrong/closed/cross-tenant would become
  // the active provenance after ON DELETE SET NULL and could then block the memory delete.
  if (sourceObject != null) {
    const table = SOURCE_OBJECT_TABLE[sourceObject.type];
    if (!table) {
      throw new Error(`${label}: unsupported source_object_type '${sourceObject.type}'`);
    }
    // `table` is a fixed value from the SOURCE_OBJECT_TABLE map (never user-supplied), so
    // this string interpolation is safe; `id`/`tenant_id` stay parametrized.
    // SAFETY: row's shape matches the single `status` column named in the
    // SELECT above.
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
  // object-only row (objects are consolidated by construction). All-null is rejected.
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
  const name = checkedName('insertEntity', opts.name);
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
    // SAFETY: row's shape matches the columns named in ENTITY_COLS above.
    const row = db.prepare(`SELECT ${ENTITY_COLS} FROM entities WHERE id = ?`).get(id) as EntityRow | undefined;
    if (!row) throw new Error('insertEntity: failed to reload inserted entity');
    return rowToEntity(row);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

function checkedName(label: string, raw: string | undefined): string {
  const name = (raw ?? '').trim();
  if (name.length === 0) throw new Error(`${label}: name is required`);
  if (name.length > MAX_ENTITY_NAME_LEN) {
    throw new Error(`${label}: name exceeds the ${MAX_ENTITY_NAME_LEN}-char cap`);
  }
  return name;
}

/** Renames an entity or moves its memory provenance in place, keeping id and created_at; null when the row is gone.
 *  A delete plus an insert would cascade away every relation that points at it. */
export function updateEntity(
  hippoRoot: string,
  tenantId: string,
  id: number,
  opts: UpdateEntityOpts,
  txDb?: GraphTxDb,
): Entity | null {
  assertTenantId('updateEntity', tenantId);
  const name = checkedName('updateEntity', opts.name);
  const db = txDb ?? openHippoDb(hippoRoot);
  try {
    // SAFETY: row's shape matches the columns named in ENTITY_COLS above.
    const row = db.prepare(`SELECT ${ENTITY_COLS} FROM entities WHERE id = ? AND tenant_id = ?`).get(id, tenantId) as EntityRow | undefined;
    if (!row) return null;
    const entity = rowToEntity(row);
    const sourceObject = entity.sourceObjectType === undefined || entity.sourceObjectId === undefined
      ? null
      : { type: entity.sourceObjectType, id: entity.sourceObjectId };
    const resolved = resolveConsolidatedSource(db, tenantId, opts.memoryId ?? null, sourceObject, 'updateEntity');
    db.prepare(`UPDATE entities SET name = ?, memory_id = ?, source_kind = ? WHERE id = ? AND tenant_id = ?`)
      .run(name, resolved.memoryId, resolved.sourceKind, id, tenantId);
    return { ...entity, name, memoryId: resolved.memoryId, sourceKind: resolved.sourceKind };
  } finally {
    if (db !== txDb) closeHippoDb(db);
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
      // SAFETY: ent's shape matches the single `tenant_id` column named in
      // the SELECT above.
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
    // SAFETY: row's shape matches the columns named in RELATION_COLS above.
    const row = db.prepare(`SELECT ${RELATION_COLS} FROM relations WHERE id = ?`).get(id) as RelationRow | undefined;
    if (!row) throw new Error('insertRelation: failed to reload inserted relation');
    return rowToRelation(row);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

// ---------------------------------------------------------------------------
// Extraction queue
// ---------------------------------------------------------------------------

/**
 * Enqueue a consolidated memory for later graph extraction. Rejects a raw / missing /
 * cross-tenant memory (the DB trigger is the backstop).
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
    // SAFETY: row's shape matches the columns named in QUEUE_COLS above.
    const row = db.prepare(`SELECT ${QUEUE_COLS} FROM graph_extraction_queue WHERE id = ?`).get(id) as QueueRow | undefined;
    if (!row) throw new Error('enqueueExtraction: failed to reload queue item');
    return rowToQueueItem(row);
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
      // SAFETY: existing's shape matches the single `status` column named in
      // the SELECT above.
      const existing = db.prepare(`SELECT status FROM graph_extraction_queue WHERE id = ? AND tenant_id = ?`)
        .get(id, tenantId) as { status: string } | undefined;
      if (!existing) throw new Error(`markExtractionProcessed: queue item ${id} not found for tenant ${tenantId}`);
      throw new Error(`markExtractionProcessed: queue item ${id} is not pending (status='${existing.status}')`);
    }
    // SAFETY: row's shape matches the columns named in QUEUE_COLS above.
    const row = db.prepare(`SELECT ${QUEUE_COLS} FROM graph_extraction_queue WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as QueueRow | undefined;
    if (!row) throw new Error(`markExtractionProcessed: queue item ${id} not found after UPDATE`);
    return rowToQueueItem(row);
  } finally {
    closeHippoDb(db);
  }
}

/** The source object still holds the loader's rule (active or superseded); a closed or gone one gets no new graph row. */
function objectInForce(db: DbLike, tenantId: string, ref: SourceObjectRef): boolean {
  // `table` comes from the fixed SOURCE_OBJECT_TABLE map, never from input.
  const table = SOURCE_OBJECT_TABLE[ref.type];
  // SAFETY: row's shape matches the single `status` column named in the SELECT.
  const row = db.prepare(`SELECT status FROM ${table} WHERE id = ? AND tenant_id = ?`).get(ref.id, tenantId) as { status: string } | undefined;
  return row?.status === 'active' || row?.status === 'superseded';
}

function entityIdByKey(db: DbLike, tenantId: string, key: NaturalKey): number | undefined {
  // SAFETY: row's shape matches the single `id` column named in the SELECT.
  const row = db.prepare(
    `SELECT id FROM entities WHERE tenant_id = ? AND entity_type = ? AND source_object_type = ? AND source_object_id = ? ORDER BY id LIMIT 1`,
  ).get(tenantId, key.entityType, key.sourceObject.type, key.sourceObject.id) as { id: number } | undefined;
  return row?.id;
}

function insertDesiredRelation(db: GraphTxDb, hippoRoot: string, tenantId: string, rel: DesiredRelation): boolean {
  const fromEntityId = entityIdByKey(db, tenantId, rel.from);
  const toEntityId = entityIdByKey(db, tenantId, rel.to);
  if (fromEntityId === undefined || toEntityId === undefined || !objectInForce(db, tenantId, rel.sourceObject)) return false;
  // SAFETY: row's shape matches the single aliased column named in the SELECT.
  const present = db.prepare(
    `SELECT 1 AS hit FROM relations WHERE tenant_id = ? AND from_entity_id = ? AND to_entity_id = ? AND rel_type = ? LIMIT 1`,
  ).get(tenantId, fromEntityId, toEntityId, rel.relType) as { hit: number } | undefined;
  if (present) return false;
  insertRelation(hippoRoot, tenantId, { fromEntityId, toEntityId, relType: rel.relType, memoryId: rel.memoryId, sourceObject: rel.sourceObject }, db);
  return true;
}

/** Applies one op; false when a writer since the diff made it stale, which the next run's diff repairs. */
function applyGraphOp(db: GraphTxDb, hippoRoot: string, tenantId: string, op: GraphOp): boolean {
  switch (op.op) {
    case 'deleteEntity':
      db.prepare(`DELETE FROM entities WHERE id = ? AND tenant_id = ?`).run(op.id, tenantId);
      return true;
    case 'deleteRelation':
      db.prepare(`DELETE FROM relations WHERE id = ? AND tenant_id = ?`).run(op.id, tenantId);
      return true;
    case 'updateEntity':
      if (!objectInForce(db, tenantId, op.entity.sourceObject)) return false;
      return updateEntity(hippoRoot, tenantId, op.id, op.entity, db) !== null;
    case 'insertEntity':
      // A mirrorless object closed since the load is never enqueued again, so a stale insert would stay for good.
      if (!objectInForce(db, tenantId, op.entity.sourceObject) || entityIdByKey(db, tenantId, op.entity) !== undefined) return false;
      insertEntity(hippoRoot, tenantId, op.entity, db);
      return true;
    case 'insertRelation':
      return insertDesiredRelation(db, hippoRoot, tenantId, op.relation);
  }
}

export interface ApplyGraphOpsResult {
  readonly next: number;
  readonly skipped: number;
}

/** Applies `ops` from index `opts.from` on the caller's open transaction and stops at the first op boundary past `opts.holdMs`.
 *  Returns where the next chunk starts and how many ops were skipped as stale. */
export function applyGraphOps(
  db: GraphTxDb,
  hippoRoot: string,
  tenantId: string,
  ops: readonly GraphOp[],
  opts: { readonly from: number; readonly holdMs: number; readonly clock?: () => number },
): ApplyGraphOpsResult {
  assertTenantId('applyGraphOps', tenantId);
  const now = opts.clock ?? clock;
  const begunAt = now();
  let next = opts.from;
  let skipped = 0;
  while (next < ops.length) {
    if (!applyGraphOp(db, hippoRoot, tenantId, ops[next])) skipped += 1;
    next += 1;
    if (now() - begunAt >= opts.holdMs) break;
  }
  return { next, skipped };
}

/** Runs one tenant's graph writes in `fn` on `txDb` under one BEGIN IMMEDIATE, so two rebuilds serialize instead of
 *  interleaving and a throw rolls back the whole chunk. The sole sanctioned place to wrap graph writes in a transaction. */
export function runGraphRebuildTransaction<T>(
  hippoRoot: string,
  tenantId: string,
  fn: (txDb: GraphTxDb) => T,
  opts?: { busyWaitMs?: number },
): T {
  assertTenantId('runGraphRebuildTransaction', tenantId);
  const db = openHippoDb(hippoRoot, opts);
  try {
    return withWriteScope(db, 'graph_rebuild', () => fn(db));
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// Sleep enqueue-hook: producer helper + drain support
// ---------------------------------------------------------------------------

/**
 * Fail-soft producer hook: mark a tenant dirty for graph re-extraction by
 * enqueuing its consolidated mirror memory. NEVER throws into the caller — a
 * graph-dirty signal failing must not abort a core object write. Graph staleness is
 * recoverable (next sleep / manual `graph extract`); a broken `hippo decide` is
 * not. Called POST-COMMIT from the graph-source save/close mutations of
 * decision, policy, customer_note and project_brief. A null memoryId (a
 * forgotten mirror) is a no-op.
 */
export function markGraphDirty(hippoRoot: string, tenantId: string, memoryId: string | null): void {
  if (!memoryId) return;
  try {
    enqueueExtraction(hippoRoot, tenantId, memoryId);
  } catch (err) {
    // Logged (warn) so a SYSTEMATIC enqueue failure surfaces to operators, but
    // swallowed so the already-committed object write is never rolled back.
    log.warn(
      `markGraphDirty: enqueue failed for tenant=${tenantId} memory=${memoryId}: ${errorMessage(err)}`,
    );
  }
}

/**
 * Remove the graph rows sourced from one first-class object, by its (type, id). Used when a
 * MIRRORLESS object is closed: it has no mirror memory, so `markGraphDirty` cannot
 * enqueue a rebuild (the queue is memory-keyed). Closing must still drop the object's
 * now-stale entity + edges from the graph, so we remove them directly here. Fail-soft
 * like `markGraphDirty` (never throws into the object close caller; graph staleness is
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
      withWriteScope(db, 'remove_graph_entities', () => {
        db.prepare(`DELETE FROM relations WHERE tenant_id = ? AND source_object_type = ? AND source_object_id = ?`)
          .run(tenantId, sourceObjectType, sourceObjectId);
        db.prepare(`DELETE FROM entities WHERE tenant_id = ? AND source_object_type = ? AND source_object_id = ?`)
          .run(tenantId, sourceObjectType, sourceObjectId);
      });
    } finally {
      closeHippoDb(db);
    }
  } catch (err) {
    log.warn(
      `removeGraphEntitiesForObject: failed for tenant=${tenantId} ${sourceObjectType}#${sourceObjectId}: ${errorMessage(err)}`,
    );
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
