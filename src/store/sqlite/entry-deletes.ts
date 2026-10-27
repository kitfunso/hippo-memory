// hippo.db's row deletes: one row or many, with forget rows, dirty parents and mirror purges.
import { RawAppendOnlyError } from '../../base/errors/raw-append-only.js';
import { AUTO_DELETABLE } from './rule-sql.js';
import type { SqlFragment } from '../../db/sql.js';
import { openHippoDb, withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import { audit } from './audit-event.js';
import { deleteFtsRow } from './entry-row.js';
import { purgeMirrorBestEffort } from './mirrors.js';
import type { StoreFiles } from './open.js';
import { chunked } from '../../base/util/chunked.js';
import { placeholders } from '../../db/sql.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';

/** Tables whose rows keep a first-class object's backing memory in `memory_id` (ON DELETE SET
 * NULL); tests/store/dormant-memories.test.ts pins it to the schema. */
export const MEMORY_BACKED_TABLES = [
  'predictions',
  'decisions',
  'incidents',
  'processes',
  'policies',
  'skills',
  'project_briefs',
  'customer_notes',
] as const;

/** Deleting a memory that backs an object nulls the object's link, and no restore can repair it,
 * so no automatic pass may. */
export const AUTOMATIC_DELETE: SqlFragment = {
  sql: `${AUTO_DELETABLE.sql}${MEMORY_BACKED_TABLES.map(
    (t) => ` AND NOT EXISTS (SELECT 1 FROM ${t} WHERE ${t}.memory_id = memories.id)`,
  ).join('')}`,
  params: AUTO_DELETABLE.params,
};

/** The ids among `ids` that back a first-class object, one statement per chunk, for passes that
 * plan deletes before making them. */
export function memoriesBackingAmong(db: DatabaseSyncLike, ids: readonly string[]): Set<string> {
  const backed = new Set<string>();
  if (ids.length === 0) return backed;
  const tables = backingTables(db);
  // The NOT NULL term lets each table's partial memory_id index answer the IN.
  const sql = tables
    .map(
      (t) =>
        `SELECT memory_id FROM ${t} WHERE memory_id IS NOT NULL AND memory_id IN (SELECT value FROM json_each(?))`,
    )
    .join(' UNION ');
  for (const chunk of chunked([...new Set(ids)])) {
    const list = JSON.stringify(chunk);
    // SAFETY: every arm selects memory_id under IS NOT NULL.
    const rows = cachedStatement(db, sql).all(...tables.map(() => list)) as Array<{
      memory_id: string;
    }>;
    for (const row of rows) backed.add(row.memory_id);
  }
  return backed;
}

// Quality repair opens an older schema unmigrated, which can lack some of the tables.
function backingTables(db: DatabaseSyncLike): string[] {
  const rows = cachedStatement(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders(MEMORY_BACKED_TABLES.length)})`,
  ).all(...MEMORY_BACKED_TABLES) as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));
  return MEMORY_BACKED_TABLES.filter((table) => present.has(table));
}

// The abort text of trg_memories_raw_append_only (migration v14), the one place src matches it.
const RAW_TRIGGER_TEXT = 'raw is append-only';

function isRawTriggerAbort(cause: unknown): cause is Error {
  return cause instanceof Error && cause.message.includes(RAW_TRIGGER_TEXT);
}

/** Runs the DELETE and returns the rows it removed; the raw-row trigger's abort becomes
 * RawAppendOnlyError. */
function deleteMemoryRow(
  db: ReturnType<typeof openHippoDb>,
  sql: string,
  params: SqlFragment['params'],
): number {
  try {
    return Number(cachedStatement(db, sql).run(...params).changes ?? 0);
  } catch (cause) {
    throw isRawTriggerAbort(cause) ? new RawAppendOnlyError(cause) : cause;
  }
}

/** db-scoped delete core, composable inside a caller's transaction; NO filesystem I/O, mirrors
 * are written post-commit. `suppressForgetAudit` is set by rejectValue and resolveConflict (own
 * audit row). Returns `{tenantId, dagParentId}`, or null if the tenant holds no such row or
 * `automatic` refused it. */
export function deleteEntryCore(
  db: ReturnType<typeof openHippoDb>,
  id: string,
  tenantId: string,
  opts?: { actor?: string; suppressForgetAudit?: boolean; reason?: string; automatic?: boolean },
): { tenantId: string; dagParentId: string | null } | null {
  const row = cachedStatement(
    db,
    `SELECT ${DELETE_TARGET_COLUMNS} FROM memories WHERE id = ? AND tenant_id = ?`,
  ).get(id, tenantId) as DeleteTarget | undefined;
  return row?.id ? deleteTargetRow(db, row, opts) : null;
}

// SAFETY: every read cast to this row selects DELETE_TARGET_COLUMNS; scripts/check-row-casts.mjs
// proves it.
interface DeleteTarget {
  id: string;
  tenant_id: string;
  dag_parent_id?: string | null;
}
const DELETE_TARGET_COLUMNS = 'id, tenant_id, dag_parent_id';

function deleteTargetRow(
  db: DatabaseSyncLike,
  row: DeleteTarget,
  opts?: { actor?: string; suppressForgetAudit?: boolean; reason?: string; automatic?: boolean },
): { tenantId: string; dagParentId: string | null } | null {
  const { id, tenant_id: tenantId } = row;
  const guard = opts?.automatic ? AUTOMATIC_DELETE : null;
  // The tenant is in the WHERE so the DELETE itself cannot reach a row the read did not.
  const sql = `DELETE FROM memories WHERE id = ? AND tenant_id = ?${guard ? ` AND ${guard.sql}` : ''}`;
  if (deleteMemoryRow(db, sql, [id, tenantId, ...(guard?.params ?? [])]) === 0) return null;
  deleteFtsRow(db, id);
  if (!opts?.suppressForgetAudit) {
    audit(db, 'forget', {
      targetId: id,
      metadata: opts?.reason ? { reason: opts.reason } : undefined,
      actor: opts?.actor ?? CLI_ACTOR,
      tenantId,
    });
  }
  // Forgetting a child of a summary marks the parent dirty. Not atomic with the DELETE, but
  // markSummaryDirtyInTx is idempotent, so the next child mutation re-marks the parent if this
  // fails.
  if (row.dag_parent_id) {
    const actor = opts?.actor ?? CLI_ACTOR;
    markSummaryDirtyInTx(db, { summaryId: row.dag_parent_id, tenantId, actor });
  }
  return { tenantId, dagParentId: row.dag_parent_id ?? null };
}

/** Deletes each target with its own forget row and reason, one transaction per chunk after one
 * read of its ids; `true` where the row went, so a repeated id is true once. A host-wide pass:
 * each row's own tenant goes into its DELETE. */
export function deleteEntriesInBatches(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  targets: readonly { id: string; reason: string }[],
  opts: { actor?: string; automatic?: boolean },
): boolean[] {
  const gone = new Set<string>();
  for (const chunk of chunked(targets)) {
    const deleted = withWriteScope(db, 'delete_entries', () => {
      const rows = readDeleteTargets(
        db,
        chunk.map((target) => target.id),
      );
      return chunk
        .filter(({ id, reason }) => {
          const row = rows.get(id);
          return row !== undefined && deleteTargetRow(db, row, { ...opts, reason }) !== null;
        })
        .map((target) => target.id);
    });
    for (const id of deleted) {
      gone.add(id);
      purgeMirrorBestEffort(hippoRoot, { id, isRaw: false, logPrefix: 'deleteEntry' });
    }
  }
  return targets.map((target) => gone.delete(target.id));
}

function readDeleteTargets(
  db: DatabaseSyncLike,
  ids: readonly string[],
): Map<string, DeleteTarget> {
  const rows = new Map<string, DeleteTarget>();
  for (const chunk of chunked([...new Set(ids)])) {
    const found = cachedStatement(
      db,
      `SELECT ${DELETE_TARGET_COLUMNS} FROM memories WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(chunk)) as Array<DeleteTarget>;
    for (const row of found) rows.set(row.id, row);
  }
  return rows;
}
