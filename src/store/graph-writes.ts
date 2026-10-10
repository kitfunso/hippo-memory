// The writer of the entities and relations tables. Every row resolves a consolidated source first, never a raw memory;
// the schema triggers are the backstop for a write that skips this module.
import { openHippoDb, closeHippoDb, withWriteScope, type DatabaseSyncLike } from '../db/index.js';
import { onHandle } from './open.js';
import { assertTenantId } from './tenant.js';
import { errorMessage, log } from '../util/log.js';
import {
  type EntityType,
  type RelationType,
  type SourceKind,
  type SourceObjectType,
  type SourceObjectRef,
  GRAPH_ENTITY_TYPES,
  GRAPH_RELATION_TYPES,
  MAX_ENTITY_NAME_LEN,
  type Entity,
  type Relation,
  type InsertEntityOpts,
  type InsertRelationOpts,
  type UpdateEntityOpts,
  type EntityRow,
  type RelationRow,
  rowToEntity,
  rowToRelation,
  ENTITY_COLS,
  RELATION_COLS
} from './graph-rows.js';

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

/** Resolve `source_kind` for a graph row from AT LEAST ONE valid provenance path, mirroring the DB trigger guard; raw is rejected.
 * MEMORY path: exists, same-tenant, consolidated. OBJECT path (`memoryId` null): same-tenant, active|superseded, yields 'distilled'. All-null is rejected. */
interface ResolvedGraphSource {
  sourceKind: SourceKind;
  memoryId: string | null;
}
export function resolveConsolidatedSource(
  db: DatabaseSyncLike,
  tenantId: string,
  memoryId: string | null,
  sourceObject: SourceObjectRef | null,
  label: string,
): ResolvedGraphSource {
  const { memKind, effectiveMemoryId } = checkSourceMemory(db, tenantId, memoryId, sourceObject, label);
  assertSourceObjectUsable(db, tenantId, sourceObject, label);

  // source_kind is the memory's kind when a memory is present, else 'distilled' for an
  // object-only row (objects are consolidated by construction). All-null is rejected.
  if (memKind != null) return { sourceKind: memKind, memoryId: effectiveMemoryId };
  if (sourceObject != null) return { sourceKind: 'distilled', memoryId: null };
  throw new Error(`${label}: graph row needs a memory or a source object`);
}

interface CheckedSourceMemory {
  memKind: SourceKind | null;
  effectiveMemoryId: string | null;
}

function checkSourceMemory(
  db: DatabaseSyncLike,
  tenantId: string,
  memoryId: string | null,
  sourceObject: SourceObjectRef | null,
  label: string,
): CheckedSourceMemory {
  let memKind: SourceKind | null = null;
  let effectiveMemoryId: string | null = memoryId;
  if (memoryId != null) {
    // SAFETY: row's shape matches the two columns (kind, tenant_id) named in
    // the SELECT above.
    const row = db.prepare(`SELECT kind, tenant_id FROM memories WHERE id = ?`).get(memoryId) as
      | { kind: string; tenant_id: string }
      | undefined;
    if (!row) {
      // Stale/forgotten mirror: tolerate it IFF a valid source object gives provenance, so a mirror pruned mid graph-extract does not roll back the tenant
      // rebuild; anchor to the object and drop the dead memory pointer.
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
  return { memKind, effectiveMemoryId };
}

function assertSourceObjectUsable(db: DatabaseSyncLike, tenantId: string, sourceObject: SourceObjectRef | null, label: string): void {
  // Validate the object pointer WHENEVER provided: a dual-set row with a bad object would become the provenance after ON DELETE SET NULL and could block
  // the memory delete.
  if (sourceObject != null) {
    const table = SOURCE_OBJECT_TABLE[sourceObject.type];
    if (!table) {
      throw new Error(`${label}: unsupported source_object_type '${sourceObject.type}'`);
    }
    // `table` is a fixed SOURCE_OBJECT_TABLE value (never user-supplied), so interpolation is safe; `id`/`tenant_id` stay parametrized.
    // SAFETY: row's shape matches the single `status` column named in the SELECT above.
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
}

/** Insert a graph entity extracted from a consolidated memory; throws if the source memory is missing / cross-tenant / raw (the DB trigger is the backstop). */
export function insertEntity(
  hippoRoot: string,
  tenantId: string,
  opts: InsertEntityOpts,
  txDb?: DatabaseSyncLike,
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
  txDb?: DatabaseSyncLike,
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

/** Insert a graph relation between two same-tenant entities, sourced from a consolidated memory. */
export function insertRelation(
  hippoRoot: string,
  tenantId: string,
  opts: InsertRelationOpts,
  txDb?: DatabaseSyncLike,
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
    `).run(
      tenantId,
      opts.fromEntityId,
      opts.toEntityId,
      opts.relType,
      effectiveMemoryId,
      sourceKind,
      sourceObject?.type ?? null,
      sourceObject?.id ?? null,
      now
    );
    const id = Number(result.lastInsertRowid ?? 0);
    // SAFETY: row's shape matches the columns named in RELATION_COLS above.
    const row = db.prepare(`SELECT ${RELATION_COLS} FROM relations WHERE id = ?`).get(id) as RelationRow | undefined;
    if (!row) throw new Error('insertRelation: failed to reload inserted relation');
    return rowToRelation(row);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

/** The source object still holds the loader's rule (active or superseded); a closed or gone one gets no new graph row. */
export function objectInForce(db: DatabaseSyncLike, tenantId: string, ref: SourceObjectRef): boolean {
  // `table` comes from the fixed SOURCE_OBJECT_TABLE map, never from input.
  const table = SOURCE_OBJECT_TABLE[ref.type];
  // SAFETY: row's shape matches the single `status` column named in the SELECT.
  const row = db.prepare(`SELECT status FROM ${table} WHERE id = ? AND tenant_id = ?`).get(ref.id, tenantId) as { status: string } | undefined;
  return row?.status === 'active' || row?.status === 'superseded';
}

/** The lowest-id entity of this type anchored to the source object, which is the row a rebuild keeps. */
export function entityIdBySource(db: DatabaseSyncLike, tenantId: string, entityType: EntityType, sourceObject: SourceObjectRef): number | undefined {
  // SAFETY: row's shape matches the single `id` column named in the SELECT.
  const row = db.prepare(
    `SELECT id FROM entities WHERE tenant_id = ? AND entity_type = ? AND source_object_type = ? AND source_object_id = ? ORDER BY id LIMIT 1`,
  ).get(tenantId, entityType, sourceObject.type, sourceObject.id) as { id: number } | undefined;
  return row?.id;
}

export function relationPresent(db: DatabaseSyncLike, tenantId: string, fromEntityId: number, toEntityId: number, relType: RelationType): boolean {
  // SAFETY: row's shape matches the single aliased column named in the SELECT.
  const present = db.prepare(
    `SELECT 1 AS hit FROM relations WHERE tenant_id = ? AND from_entity_id = ? AND to_entity_id = ? AND rel_type = ? LIMIT 1`,
  ).get(tenantId, fromEntityId, toEntityId, relType) as { hit: number } | undefined;
  return present !== undefined;
}

export function deleteEntityRow(db: DatabaseSyncLike, tenantId: string, id: number): void {
  db.prepare(`DELETE FROM entities WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
}

export function deleteRelationRow(db: DatabaseSyncLike, tenantId: string, id: number): void {
  db.prepare(`DELETE FROM relations WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
}

/** Runs one tenant's graph writes in `fn` on `txDb` under one BEGIN IMMEDIATE, so two rebuilds serialize instead of
 *  interleaving and a throw rolls back the whole chunk. The sole sanctioned place to wrap graph writes in a transaction. */
export function runGraphRebuildTransaction<T>(
  hippoRoot: string,
  tenantId: string,
  fn: (txDb: DatabaseSyncLike) => T,
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

/** Remove graph rows sourced from one MIRRORLESS object by (type, id) on close: with no mirror memory `markGraphDirty` cannot enqueue a rebuild.
 * Fail-soft like `markGraphDirty`; the explicit relations DELETE also covers a relation whose OWN provenance is this object. */
export function removeGraphEntitiesForObject(
  hippoRoot: string,
  tenantId: string,
  sourceObjectType: SourceObjectType,
  sourceObjectId: number,
): void {
  try {
    assertTenantId('removeGraphEntitiesForObject', tenantId);
    onHandle(hippoRoot, (db) => {
      withWriteScope(db, 'remove_graph_entities', () => {
        db.prepare(`DELETE FROM relations WHERE tenant_id = ? AND source_object_type = ? AND source_object_id = ?`)
          .run(tenantId, sourceObjectType, sourceObjectId);
        db.prepare(`DELETE FROM entities WHERE tenant_id = ? AND source_object_type = ? AND source_object_id = ?`)
          .run(tenantId, sourceObjectType, sourceObjectId);
      });
    });
  } catch (err) {
    log.warn(
      `removeGraphEntitiesForObject: failed for tenant=${tenantId} ${sourceObjectType}#${sourceObjectId}: ${errorMessage(err)}`,
    );
  }
}
