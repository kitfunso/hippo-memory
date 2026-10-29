// The typed-object writes: audit rows, close, save with versions, the half-life mirror and incident open.

import { appendAuditEvents } from '../audit/audit.js';
import {
  changedRows,
  getMeta,
  withWriteScopeOr,
  type DatabaseSyncLike,
} from '../../../db/index.js';
import { placeholders } from '../../../db/sql.js';
import { chunked } from '../../../base/util/chunked.js';
import { calculateStrength, LEGACY_TYPED_HALF_LIFE } from '../../../base/memory/strength.js';
import { deriveHalfLife, type MemoryEntry } from '../../../base/memory/entry.js';
import { stampOriginProject, upsertEntryRow } from '../entries/entry-row.js';
import { auditEntryWrite, writeEntryMirrors, auditingRefusal } from '../entries/entry-writes.js';
import { markGraphDirty } from '../graph/graph-queue.js';
import { removeGraphEntitiesForObject } from '../graph/graph-writes.js';
import {
  isObjectRefusal,
  type Incident,
  type ObjectByKind,
  type ObjectKind,
  type ObjectRefusal,
  type SavableKind,
  type IncidentFields,
  type ObjectFields,
} from '../../../base/records/object-types.js';
import type { OnHandle, StoreFiles, StoreModel } from '../runtime/open.js';
import { openStore } from '../runtime/handles.js';
import type {
  IncidentOpen,
  IncidentOpenRefusal,
  IncidentResolve,
  ObjectClose,
  ObjectCloseArgs,
  ObjectSave,
  ObjectSaveArgs,
} from '../../../base/ports/store/objects.js';
import { type ColumnValue, insertSpec, rowSpec, type RowByKind } from './object-rows.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { closePrediction, writePrediction } from '../learning/predictions.js';
import type { AuditOp } from '../../../base/records/audit-ops.js';
import type { JsonObject } from '../../../base/util/json.js';
import { META_KEY } from '../../../db/meta.js';
import { KINDS, SAVE_RULES, hasText, isVersioned, objectTable, readRow } from './object-rows.js';

/** One audit row's op, target and metadata; the adapter adds the tenant and actor. */
interface ObjectAudit {
  readonly op: AuditOp;
  readonly targetId: string;
  readonly metadata: JsonObject;
}

function createAudit<K extends SavableKind>(
  kind: K,
  id: number,
  fields: ObjectFields[K],
  version: number,
): ObjectAudit {
  const metadata = { [KINDS[kind].idKey]: id, ...SAVE_RULES[kind].createKeys(fields, version) };
  return { op: `${kind}_create`, targetId: String(id), metadata };
}

/** The object id `replaced`, the id that replaces it and that row's version. */
interface SupersedeAuditOptions {
  readonly replaced: number;
  readonly id: number;
  readonly version: number;
}

/** The row for `replaced` giving way to `id`, which holds `version`. */
function supersedeAudit<K extends SavableKind>(
  kind: K,
  { replaced, id, version }: SupersedeAuditOptions,
  fields: ObjectFields[K],
): ObjectAudit {
  const rule = SAVE_RULES[kind];
  const own: JsonObject = { [KINDS[kind].idKey]: replaced, superseded_by: id };
  if (rule.versioned) own.new_version = version;
  return {
    op: `${kind}_supersede`,
    targetId: String(replaced),
    metadata: { ...own, ...rule.supersedeKeys?.(fields) },
  };
}

function closeAudit(kind: ObjectKind, id: number): ObjectAudit {
  return { op: `${kind}_close`, targetId: String(id), metadata: { [KINDS[kind].idKey]: id } };
}

function incidentOpenAudit(id: number, fields: IncidentFields): ObjectAudit {
  const metadata = {
    incident_id: id,
    has_context: hasText(fields.context),
    linked_memory_count: fields.linkedMemoryIds.length,
  };
  return { op: 'incident_open', targetId: String(id), metadata };
}

export function closeAny(on: OnHandle, ...[tenantId, kind, id, change]: ObjectCloseArgs) {
  if (kind === 'prediction') return on((db) => closePrediction(db, tenantId, id, change));
  if ('text' in change) return on((db) => resolveRow(db, tenantId, id, change));
  return close(on, tenantId, kind, id, change);
}

export function saveAny(
  on: OnHandle,
  files: StoreFiles,
  ...[tenantId, kind, object]: ObjectSaveArgs
) {
  // The prediction writes its mirror files too, so it opens the store as every mirrored save does.
  if (kind === 'prediction') {
    return on((db) => writePrediction(db, files, tenantId, object), openStore);
  }
  if (kind === 'incident') return openIncident(on, tenantId, object);
  return save(on, tenantId, kind, object);
}

interface CloseRow<K extends ObjectKind> {
  readonly tenantId: string;
  readonly kind: K;
  readonly id: number;
  readonly close: ObjectClose<K>;
}

/** The status guard sits in the UPDATE, so zero rows changed means missing or not closable; the
 * reread tells which. */
function closeRow<K extends ObjectKind>(
  db: DatabaseSyncLike,
  { tenantId, kind, id, close }: CloseRow<K>,
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
    if (changedRows(updated) === 0) {
      const existing = cachedStatement(
        db,
        `SELECT status FROM ${table} WHERE id = ? AND tenant_id = ?`,
      ).get(id, tenantId) as { status: string } | undefined;
      return rollback<ObjectRefusal>(
        existing ? { refused: 'status', status: existing.status } : { refused: 'missing' },
      );
    }
    const row = readRow(db, kind, tenantId, id);
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
    const closed = closeRow(db, { tenantId, kind, id, close });
    if (isObjectRefusal(closed) || !graphType) return closed;
    // Each graph write takes its own write lock, so both wait for the commit. The rows go at once
    // because the rebuild queue is keyed by a mirror memory that may be gone.
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
    values.push(
      row.version,
      row.save.supersedesId === undefined ? null : (row.save.changeSummary ?? null),
    );
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

/** The status guard sits in the UPDATE, so a row another writer retired since the preflight
 * fails the whole save; false says so. */
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
  if (changedRows(updated) === 0) return false;
  const ids = { replaced, id, version: row.version };
  const audit = supersedeAudit(row.kind, ids, row.save.fields);
  appendAuditEvents(db, [{ tenantId: row.tenantId, actor: row.save.actor, ...audit }]);
  return true;
}

/** The object half of a save, inside the scope that holds the mirror memory: a refusal or a
 * throw here leaves no row, memory or audit event. */
function writeObjectRow<K extends SavableKind>(
  db: DatabaseSyncLike,
  { tenantId, kind, memoryId, save }: Omit<NewRow<K>, 'version'>,
): RowByKind[K] | ObjectRefusal {
  const replaced = save.supersedesId;
  const next =
    replaced === undefined ? { version: 1 } : successorVersion(db, tenantId, kind, replaced);
  if (isObjectRefusal(next)) return next;
  const row: NewRow<K> = { tenantId, kind, memoryId, save, version: next.version };
  const id = insertRow(db, row);
  if (replaced !== undefined && !supersedeRow(db, row, replaced, id)) return { refused: 'raced' };
  const saved = readRow(db, kind, tenantId, id);
  if (!saved) return { refused: 'vanished' };
  appendAuditEvents(db, [
    { tenantId, actor: save.actor, ...createAudit(kind, id, save.fields, next.version) },
  ]);
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

/** Until the typed migration has run, a mirror goes in on the flat half-life that migration
 * moves; the flag is read under the save's write lock, so the two cannot interleave. */
function onStoreHalfLife(
  db: DatabaseSyncLike,
  mirror: MemoryEntry,
  rules: StoreModel,
): MemoryEntry {
  if (getMeta(db, META_KEY.typedHalfLife, '') !== '') return mirror;
  const legacy = { ...mirror, halfLifeDays: deriveHalfLife(LEGACY_TYPED_HALF_LIFE, mirror) };
  return { ...legacy, strength: calculateStrength(legacy, rules.clock(), rules.strength) };
}

/** One write scope on one handle holds the mirror, the row `writeRow` adds, the successor link
 * and every audit row, the mirror's remember row last. */
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
    writeObjectRow(db, { tenantId, kind, memoryId, save }),
  );
  return isObjectRefusal(written) ? written : spec.rowTo(written);
}

/** The linked ids are checked once the mirror is in and before the INSERT, so a refusal undoes
 * the mirror with it. */
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
  ).run(
    memoryId,
    tenantId,
    incidentText,
    context ?? null,
    JSON.stringify(linkedMemoryIds),
    open.at,
  );
  const id = Number(result.lastInsertRowid ?? 0);
  const row = readRow(db, 'incident', tenantId, id);
  if (!row) return { refused: 'vanished' };
  appendAuditEvents(db, [{ tenantId, actor: open.actor, ...incidentOpenAudit(id, open.fields) }]);
  return row;
}

function openIncident(
  on: OnHandle,
  tenantId: string,
  open: IncidentOpen,
): Incident | IncidentOpenRefusal {
  const write: MirroredWrite = { mirror: open.mirror, actor: open.actor };
  const written = withMirror<RowByKind['incident'], IncidentOpenRefusal>(
    on,
    write,
    (db, memoryId) => openIncidentRow(db, tenantId, memoryId, open),
  );
  return 'refused' in written ? written : rowSpec('incident').rowTo(written);
}

/** The status guard sits in the UPDATE, so zero rows changed means missing or not open; the
 * reread tells which. */
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
    if (changedRows(updated) === 0) {
      const existing = cachedStatement(
        db,
        `SELECT status FROM incidents WHERE id = ? AND tenant_id = ?`,
      ).get(id, tenantId) as { status: string } | undefined;
      return rollback<ObjectRefusal>(
        existing ? { refused: 'status', status: existing.status } : { refused: 'missing' },
      );
    }
    const row = readRow(db, 'incident', tenantId, id);
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
