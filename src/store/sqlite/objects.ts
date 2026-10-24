// hippo.db's half of the Objects store group: every statement the typed objects run, each call on a handle of its own.
import { appendAuditEvents } from './audit.js';
import { getMeta, withWriteScopeOr, type DatabaseSyncLike } from '../../db/index.js';
import { escapeLike } from '../../base/util/escape.js';
import { keysetAfter } from '../../db/sql.js';
import { chunked } from '../../base/util/chunked.js';
import {
  calculateStrength,
  deriveHalfLife,
  LEGACY_TYPED_HALF_LIFE,
  type LossAversion,
  type MemoryEntry,
} from '../../base/memory/memory.js';
import { scopeAdmitSql } from './rule-sql.js';
import {
  closeAudit,
  createAudit,
  incidentOpenAudit,
  isVersioned,
  objectTable,
  supersedeAudit,
} from '../rules/objects.js';
import { stampOriginProject, upsertEntryRow } from './entry-row.js';
import { auditEntryWrite, writeEntryMirrors, auditingRefusal } from './entry-writes.js';
import { markGraphDirty } from './graph-queue.js';
import { removeGraphEntitiesForObject } from './graph-writes.js';
import {
  isObjectRefusal,
  type BriefReceipt,
  type Incident,
  type ObjectByKind,
  type ObjectKind,
  type ObjectRefusal,
  type Policy,
  type SavableKind,
  type Skill,
} from '../../base/records/object-types.js';
import { type OnHandle, TYPED_HALF_LIFE_META_KEY } from './open.js';
import { openStore } from './handles.js';
import { answered, bound, type Bodies } from './bound.js';
import type {
  IncidentOpen,
  IncidentOpenRefusal,
  IncidentResolve,
  ObjectClose,
  ObjectListQuery,
  Objects,
  ObjectSave,
  PoliciesInForceQuery,
} from '../port.js';
import { type ColumnValue, insertSpec, rowSpec, type RowByKind } from './object-rows.js';
import { placeholders } from '../../db/sql.js';
import { cachedStatement } from '../../db/statement-cache.js';

export function sqliteObjects(on: OnHandle): Objects {
  return {
    ...objectReads(on),
    closeObject: (tenantId, kind, id, change) => answered(() => close(on, tenantId, kind, id, change)),
    saveObject: (tenantId, kind, object) => answered(() => save(on, tenantId, kind, object)),
    openIncident: (tenantId, open) => answered(() => openIncident(on, tenantId, open)),
  };
}

type ObjectReads = Pick<
  Objects,
  | 'listObjects'
  | 'objectById'
  | 'resolveIncident'
  | 'policiesInForce'
  | 'activeSkillsByName'
  | 'briefReceipts'
  | 'objectIdByMemory'
>;

const objectReadsBodies: Bodies<ObjectReads> = {
  listObjects: listRows,
  objectById: rowById,
  resolveIncident: resolveRow,
  policiesInForce,
  activeSkillsByName,
  briefReceipts,
  objectIdByMemory: idByMemory,
};

function objectReads(on: OnHandle): ObjectReads {
  // SAFETY: listRows, rowById and idByMemory are generic in the kind, as ObjectReads is; the mapped Bodies type cannot
  // carry a method's type parameter, so the bound group is typed back to the methods it binds.
  return bound(on, objectReadsBodies) as ObjectReads;
}

/** The newest object in `status` that a memory mirrors, for the CLI flags that name an object by its memory id. */
function idByMemory<K extends ObjectKind>(
  db: DatabaseSyncLike,
  tenantId: string,
  kind: K,
  status: ObjectByKind[K]['status'],
  memoryId: string,
): number | null {
  const row = cachedStatement(
    db,
    `SELECT id FROM ${objectTable(kind)} WHERE memory_id = ? AND tenant_id = ? AND status = ? ORDER BY id DESC ` +
      `LIMIT 1`,
  ).get(memoryId, tenantId, status) as { id: number } | undefined;
  return row ? row.id : null;
}

function selectRow<K extends ObjectKind>(
  db: DatabaseSyncLike,
  kind: K,
  tenantId: string,
  id: number,
): RowByKind[K] | undefined {
  const spec = rowSpec(kind);
  // SAFETY: the SELECT names spec.cols, the columns the kind's row declares.
  return cachedStatement(db, `SELECT ${spec.cols} FROM ${objectTable(kind)} WHERE id = ? AND tenant_id = ?`).get(
    id,
    tenantId,
  ) as RowByKind[K] | undefined;
}

function rowById<K extends ObjectKind>(
  db: DatabaseSyncLike,
  tenantId: string,
  kind: K,
  id: number,
): ObjectByKind[K] | null {
  const row = selectRow(db, kind, tenantId, id);
  return row ? rowSpec(kind).rowTo(row) : null;
}

function listRows<K extends ObjectKind>(
  db: DatabaseSyncLike,
  tenantId: string,
  kind: K,
  query: ObjectListQuery<K>,
): ObjectByKind[K][] {
  const spec = rowSpec(kind);
  const clauses = ['tenant_id = ?'];
  const params: Array<string | number> = [tenantId];
  if (query.status) {
    clauses.push('status = ?');
    params.push(query.status);
  }
  if (query.filter && spec.filterColumn) {
    clauses.push(`${spec.filterColumn} = ?`);
    params.push(query.filter);
  }
  const after = keysetAfter('created_at', 'id', query.after);
  // SAFETY: the SELECT names spec.cols, the columns the kind's row declares, whatever the WHERE clause holds.
  const rows = cachedStatement(
    db,
    `
    SELECT ${spec.cols} FROM ${objectTable(kind)}
    WHERE ${clauses.join(' AND ')}${after.sql}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `,
  ).all(...params, ...after.params, query.limit) as RowByKind[K][];
  return rows.map((row) => spec.rowTo(row));
}

/** The status guard sits in the UPDATE, so zero rows changed means missing or not closable; the reread tells which. */
function closeRow<K extends ObjectKind>(
  db: DatabaseSyncLike,
  tenantId: string,
  kind: K,
  id: number,
  close: ObjectClose<K>,
): ObjectByKind[K] | ObjectRefusal {
  const spec = rowSpec(kind);
  const table = objectTable(kind);
  return withWriteScopeOr(db, 'close_object', (rollback) => {
    const marks = placeholders(close.from.length);
    const updated = cachedStatement(
      db,
      `UPDATE ${table} SET status = 'closed', closed_at = ? WHERE id = ? AND tenant_id = ? AND status IN ` +
        `(${marks})`,
    ).run(close.at, id, tenantId, ...close.from);
    if (updated.changes === 0) {
      const existing = cachedStatement(db, `SELECT status FROM ${table} WHERE id = ? AND tenant_id = ?`).get(
        id,
        tenantId,
      ) as { status: string } | undefined;
      return rollback<ObjectRefusal>(
        existing ? { refused: 'status', status: existing.status } : { refused: 'missing' },
      );
    }
    const row = selectRow(db, kind, tenantId, id);
    if (!row) return rollback<ObjectRefusal>({ refused: 'vanished' });
    appendAuditEvents(db, [{ tenantId, actor: close.actor, ...closeAudit(kind, id) }]);
    return spec.rowTo(row);
  });
}

function close<K extends ObjectKind>(
  on: OnHandle,
  tenantId: string,
  kind: K,
  id: number,
  close: ObjectClose<K>,
): ObjectByKind[K] | ObjectRefusal {
  const { graphType } = rowSpec(kind);
  return on((db) => {
    const closed = closeRow(db, tenantId, kind, id, close);
    if (isObjectRefusal(closed) || !graphType) return closed;
    // Each graph write takes its own write lock, so both wait for the commit. The rows go at once because the rebuild
    // queue is keyed by a mirror memory that may be gone.
    removeGraphEntitiesForObject(db, tenantId, graphType, closed.id);
    markGraphDirty(db, tenantId, closed.memoryId);
    return closed;
  });
}

interface NewRow<K extends SavableKind> {
  readonly tenantId: string;
  readonly kind: K;
  readonly memoryId: string;
  readonly save: ObjectSave<K>;
  readonly version: number;
}

/** Runs before the INSERT, so the new row's id can never be the id it replaces. */
function successorVersion(
  db: DatabaseSyncLike,
  tenantId: string,
  kind: SavableKind,
  replaced: number,
): { version: number } | ObjectRefusal {
  // SAFETY: the SELECT names status, and version or a 0 AS version for a kind with no versions.
  const pred = cachedStatement(
    db,
    `SELECT status, ${isVersioned(kind) ? 'version' : '0 AS version'} FROM ${objectTable(kind)} WHERE ` +
      `id = ? AND tenant_id = ?`,
  ).get(replaced, tenantId) as { status: string; version: number } | undefined;
  if (!pred) return { refused: 'missing' };
  if (pred.status !== 'active') return { refused: 'status', status: pred.status };
  return { version: pred.version + 1 };
}

function insertRow<K extends SavableKind>(db: DatabaseSyncLike, row: NewRow<K>): number {
  const insert = insertSpec(row.kind);
  const cols = ['memory_id', 'tenant_id', ...insert.columns];
  const values: ColumnValue[] = [row.memoryId, row.tenantId, ...insert.values(row.save.fields)];
  if (isVersioned(row.kind)) {
    cols.push('version', 'change_summary');
    values.push(row.version, row.save.supersedesId === undefined ? null : (row.save.changeSummary ?? null));
  }
  const result = cachedStatement(
    db,
    `
    INSERT INTO ${objectTable(row.kind)}(${cols.join(', ')}, status, superseded_by, superseded_at, closed_at,
    created_at)
    VALUES (${placeholders(cols.length)}, 'active', NULL, NULL, NULL, ?)
  `,
  ).run(...values, row.save.at);
  return Number(result.lastInsertRowid ?? 0);
}

/** The status guard sits in the UPDATE, so a row another writer retired since the preflight fails the whole save; false
 * says so. */
function supersedeRow<K extends SavableKind>(
  db: DatabaseSyncLike,
  row: NewRow<K>,
  replaced: number,
  id: number,
): boolean {
  const updated = cachedStatement(
    db,
    `
    UPDATE ${objectTable(row.kind)}
    SET status = 'superseded', superseded_by = ?, superseded_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'active' AND id != ?
  `,
  ).run(id, row.save.at, replaced, row.tenantId, id);
  if (updated.changes === 0) return false;
  const audit = supersedeAudit(row.kind, replaced, id, row.version, row.save.fields);
  appendAuditEvents(db, [{ tenantId: row.tenantId, actor: row.save.actor, ...audit }]);
  return true;
}

/** The object half of a save, inside the scope that holds the mirror memory: a refusal or a throw here leaves no row,
 * memory or audit event. */
function writeObjectRow<K extends SavableKind>(
  db: DatabaseSyncLike,
  tenantId: string,
  kind: K,
  memoryId: string,
  save: ObjectSave<K>,
): RowByKind[K] | ObjectRefusal {
  const replaced = save.supersedesId;
  const next = replaced === undefined ? { version: 1 } : successorVersion(db, tenantId, kind, replaced);
  if (isObjectRefusal(next)) return next;
  const row: NewRow<K> = { tenantId, kind, memoryId, save, version: next.version };
  const id = insertRow(db, row);
  if (replaced !== undefined && !supersedeRow(db, row, replaced, id)) return { refused: 'raced' };
  const saved = selectRow(db, kind, tenantId, id);
  if (!saved) return { refused: 'vanished' };
  appendAuditEvents(db, [{ tenantId, actor: save.actor, ...createAudit(kind, id, save.fields, next.version) }]);
  return saved;
}

/** What a write hands back in place of a row. */
interface Refused {
  readonly refused: string;
}

function refusalOf<R extends object, F extends Refused>(written: R | F): written is F {
  return 'refused' in written;
}

interface MirroredWrite {
  readonly mirror: MemoryEntry;
  readonly actor: string;
  /** Set for a kind the graph reads, so its mirror is queued for a rebuild. */
  readonly graphTenant?: string;
}

/** Until the typed migration has run, a mirror goes in on the flat half-life that migration moves; the flag is read
 * under the save's write lock, so the two cannot interleave. */
function onStoreHalfLife(db: DatabaseSyncLike, mirror: MemoryEntry, rules: LossAversion): MemoryEntry {
  if (getMeta(db, TYPED_HALF_LIFE_META_KEY, '') !== '') return mirror;
  const legacy = { ...mirror, halfLifeDays: deriveHalfLife(LEGACY_TYPED_HALF_LIFE, mirror) };
  return { ...legacy, strength: calculateStrength(legacy, undefined, rules) };
}

/** One write scope on one handle holds the mirror, the row `writeRow` adds, the successor link and every audit row, the
 * mirror's remember row last. */
function withMirror<R extends object, F extends Refused>(
  on: OnHandle,
  write: MirroredWrite,
  writeRow: (db: DatabaseSyncLike, memoryId: string) => R | F,
): R | F {
  return on(
    (db, files) =>
      auditingRefusal(db, write.actor, () => {
        let mirror = stampOriginProject(files, write.mirror);
        const written = withWriteScopeOr(db, 'write_entry', (rollback) => {
          mirror = onStoreHalfLife(db, mirror, files);
          upsertEntryRow(db, mirror);
          const row = writeRow(db, mirror.id);
          if (refusalOf<R, F>(row)) return rollback(row);
          auditEntryWrite(db, mirror, write.actor);
          return row;
        });
        if (refusalOf<R, F>(written)) return written;
        // The graph mark takes its own write lock, so it waits for the commit.
        if (write.graphTenant !== undefined) markGraphDirty(db, write.graphTenant, mirror.id);
        writeEntryMirrors(files.hippoRoot, mirror);
        return written;
      }),
    openStore,
  );
}

function save<K extends SavableKind>(
  on: OnHandle,
  tenantId: string,
  kind: K,
  save: ObjectSave<K>,
): ObjectByKind[K] | ObjectRefusal {
  const spec = rowSpec(kind);
  const write: MirroredWrite = {
    mirror: save.mirror,
    actor: save.actor,
    graphTenant: spec.graphType ? tenantId : undefined,
  };
  const written = withMirror<RowByKind[K], ObjectRefusal>(on, write, (db, memoryId) =>
    writeObjectRow(db, tenantId, kind, memoryId, save),
  );
  return isObjectRefusal(written) ? written : spec.rowTo(written);
}

/** The linked ids are checked once the mirror is in and before the INSERT, so a refusal undoes the mirror with it. */
function openIncidentRow(
  db: DatabaseSyncLike,
  tenantId: string,
  memoryId: string,
  open: IncidentOpen,
): RowByKind['incident'] | IncidentOpenRefusal {
  const { incidentText, context, linkedMemoryIds } = open.fields;
  const held = new Set<string>();
  for (const ids of chunked(linkedMemoryIds)) {
    const found = cachedStatement(
      db,
      `SELECT id FROM memories WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))`,
    ).all(tenantId, JSON.stringify(ids)) as Array<{ id: string }>;
    for (const r of found) held.add(r.id);
  }
  const missing = linkedMemoryIds.find((linkId) => !held.has(linkId));
  if (missing !== undefined) return { refused: 'unlinked', memoryId: missing };
  const result = cachedStatement(
    db,
    `
    INSERT INTO incidents(
      memory_id, tenant_id, incident_text, context,
      status, resolution_text, resolved_at, closed_at, linked_memory_ids, created_at
    ) VALUES (?, ?, ?, ?, 'open', NULL, NULL, NULL, ?, ?)
  `,
  ).run(memoryId, tenantId, incidentText, context ?? null, JSON.stringify(linkedMemoryIds), open.at);
  const id = Number(result.lastInsertRowid ?? 0);
  const row = selectRow(db, 'incident', tenantId, id);
  if (!row) return { refused: 'vanished' };
  appendAuditEvents(db, [{ tenantId, actor: open.actor, ...incidentOpenAudit(id, open.fields) }]);
  return row;
}

function openIncident(on: OnHandle, tenantId: string, open: IncidentOpen): Incident | IncidentOpenRefusal {
  const write: MirroredWrite = { mirror: open.mirror, actor: open.actor };
  const written = withMirror<RowByKind['incident'], IncidentOpenRefusal>(on, write, (db, memoryId) =>
    openIncidentRow(db, tenantId, memoryId, open),
  );
  return 'refused' in written ? written : rowSpec('incident').rowTo(written);
}

/** The status guard sits in the UPDATE, so zero rows changed means missing or not open; the reread tells which. */
function resolveRow(
  db: DatabaseSyncLike,
  tenantId: string,
  id: number,
  resolve: IncidentResolve,
): Incident | ObjectRefusal {
  return withWriteScopeOr(db, 'resolve_incident', (rollback) => {
    const updated = cachedStatement(
      db,
      `
      UPDATE incidents
      SET status = 'resolved', resolution_text = ?, resolved_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'open'
    `,
    ).run(resolve.text, resolve.at, id, tenantId);
    if (updated.changes === 0) {
      const existing = cachedStatement(db, `SELECT status FROM incidents WHERE id = ? AND tenant_id = ?`).get(
        id,
        tenantId,
      ) as { status: string } | undefined;
      return rollback<ObjectRefusal>(
        existing ? { refused: 'status', status: existing.status } : { refused: 'missing' },
      );
    }
    const row = selectRow(db, 'incident', tenantId, id);
    if (!row) return rollback<ObjectRefusal>({ refused: 'vanished' });
    appendAuditEvents(db, [
      {
        tenantId,
        actor: resolve.actor,
        op: 'incident_resolve',
        targetId: String(id),
        metadata: { incident_id: id },
      },
    ]);
    return rowSpec('incident').rowTo(row);
  });
}

/**
 * The successor is joined in so a superseded version is kept only while the row that replaced it is not yet in force.
 */
function policiesInForce(db: DatabaseSyncLike, tenantId: string, query: PoliciesInForceQuery): Policy[] {
  const { asOf, name } = query;
  const nameClause = name !== undefined ? 'AND p.policy_name = ?' : '';
  const params: Array<string | number> = [tenantId, asOf, asOf, asOf];
  if (name !== undefined) params.push(name);
  const rows = cachedStatement(
    db,
    `
      SELECT p.id, p.memory_id, p.tenant_id, p.policy_name, p.policy_text,
             p.valid_from, p.valid_to, p.version, p.status, p.superseded_by,
             p.superseded_at, p.change_summary, p.closed_at, p.created_at
      FROM policies p
      LEFT JOIN policies s ON s.id = p.superseded_by
      WHERE p.tenant_id = ? AND p.status != 'closed'
        AND p.valid_from <= ? AND (p.valid_to IS NULL OR ? < p.valid_to)
        AND (p.status = 'active' OR (s.id IS NOT NULL AND s.valid_from > ?))
        ${nameClause}
      ORDER BY p.valid_from DESC, p.id DESC
      LIMIT ?
    `,
  ).all(...params, query.limit) as RowByKind['policy'][];
  return rows.map(rowSpec('policy').rowTo);
}

function activeSkillsByName(db: DatabaseSyncLike, tenantId: string, limit: number): Skill[] {
  // SAFETY: the SELECT names the skill row's own column list.
  const rows = cachedStatement(
    db,
    `
      SELECT ${rowSpec('skill').cols} FROM skills
      WHERE tenant_id = ? AND status = 'active'
      ORDER BY skill_name ASC, id ASC
      LIMIT ?
    `,
  ).all(tenantId, limit) as RowByKind['skill'][];
  return rows.map(rowSpec('skill').rowTo);
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
type BriefReceiptDbRow = BriefReceipt;

/** The quotes around the tag stop `path:hip` matching a memory tagged `path:hippo`. */
function briefReceipts(db: DatabaseSyncLike, tenantId: string, tag: string, limit: number): BriefReceipt[] {
  const admit = scopeAdmitSql('');
  return cachedStatement(
    db,
    `
      SELECT id, created, source, content FROM memories
      WHERE tenant_id = ?
        AND source != 'project_brief'
        AND LOWER(tags_json) LIKE ? ESCAPE '\\'
        AND ${admit.sql}
      ORDER BY created DESC, id DESC
      LIMIT ?
    `,
  ).all(tenantId, `%"${escapeLike(tag)}"%`, ...admit.params, limit) as BriefReceiptDbRow[];
}
