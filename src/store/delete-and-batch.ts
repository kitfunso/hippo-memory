import { AUTO_DELETABLE_SQL, type MemoryEntry } from '../memory.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { checkRejectionGuard, RejectedValueError } from '../rejection.js';
import { markSummaryDirtyInTx } from '../summary-dirty.js';
import { type DormantMove, insertDormantRow } from '../dormant.js';
import { log } from '../log.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './rows.js';
import { audit } from './audit-event.js';
import { deleteFtsRow, stampOriginProject, upsertEntryRow } from './entry-row.js';
import { purgeMirrorBestEffort, mirrorBestEffort, writeMarkdownMirror } from './mirrors.js';
import { openStore } from './open.js';

/** Tables whose rows keep a first-class object's backing memory in `memory_id` (ON DELETE SET NULL); tests/dormant-memories.test.ts pins it to the schema. */
export const MEMORY_BACKED_TABLES = ['predictions', 'decisions', 'incidents', 'processes', 'policies', 'skills', 'project_briefs', 'customer_notes'] as const;

/** Deleting a memory that backs an object nulls the object's link, and no restore can repair it, so no automatic pass may. */
const AUTOMATIC_DELETE_SQL = `${AUTO_DELETABLE_SQL}${MEMORY_BACKED_TABLES.map((t) => ` AND NOT EXISTS (SELECT 1 FROM ${t} WHERE ${t}.memory_id = memories.id)`).join('')}`;

/** Ids of memories that back a first-class object, for passes that plan deletes before making them. A table missing from an older schema is skipped. */
export function memoriesBackingObjects(hippoRoot: string): Set<string> {
  const ids = new Set<string>();
  const db = openHippoDb(hippoRoot);
  try {
    for (const table of MEMORY_BACKED_TABLES) {
      try {
        // SAFETY: SELECT of one nullable TEXT column, filtered to non-null.
        const rows = db.prepare(`SELECT memory_id FROM ${table} WHERE memory_id IS NOT NULL`).all() as { memory_id: string }[];
        for (const r of rows) ids.add(r.memory_id);
      } catch (err) {
        // A missing table is an older schema; any other error could hide a backing memory, so the caller stops.
        if (!(err instanceof Error && err.message.includes('no such table'))) throw err;
      }
    }
  } finally {
    closeHippoDb(db);
  }
  return ids;
}

/**
 * db-scoped delete core, so a delete can compose inside a caller's transaction.
 * NO filesystem I/O: the caller's transaction may still roll back, and mirrors are written post-commit.
 *
 * `opts.suppressForgetAudit` (default false): `rejectValue` and `resolveConflict` set it because each
 * writes its own aggregate audit row, so a removed row must not ALSO emit a `forget` row.
 *
 * Returns `{tenantId, dagParentId}` for the removed row, or `null` if no row with `id`
 * existed or `automatic` refused it (pinned, raw, kept for good or backing an object at DELETE time, so a late pin wins).
 */
export function deleteEntryCore(
  db: ReturnType<typeof openHippoDb>,
  id: string,
  opts?: { actor?: string; suppressForgetAudit?: boolean; reason?: string; automatic?: boolean },
): { tenantId: string; dagParentId: string | null } | null {
  // SAFETY: row's shape matches the three columns named in the SELECT above.
  const row = db
    .prepare(`SELECT id, tenant_id, dag_parent_id FROM memories WHERE id = ?`)
    .get(id) as { id?: string; tenant_id?: string; dag_parent_id?: string | null } | undefined;
  if (!row?.id) return null;

  const guard = opts?.automatic ? ` AND ${AUTOMATIC_DELETE_SQL}` : '';
  if (Number(db.prepare(`DELETE FROM memories WHERE id = ?${guard}`).run(id).changes ?? 0) === 0) return null;
  deleteFtsRow(db, id);
  if (!opts?.suppressForgetAudit) {
    audit(db, 'forget', id, opts?.reason ? { reason: opts.reason } : undefined, opts?.actor ?? 'cli', row.tenant_id);
  }
  // Forgetting a child of a summary marks the parent dirty. Not atomic with the DELETE, but
  // markSummaryDirtyInTx is idempotent, so the next child mutation re-marks the parent if this fails.
  if (row.dag_parent_id) {
    markSummaryDirtyInTx(db, row.dag_parent_id, row.tenant_id ?? 'default', opts?.actor ?? 'cli');
  }
  return { tenantId: row.tenant_id ?? 'default', dagParentId: row.dag_parent_id ?? null };
}

/**
 * Delete an entry from SQLite and mirrors.
 *
 * `opts.actor` defaults to 'cli'. The api.* layer threads `ctx.actor` so HTTP
 * callers land with `api_key:<key_id>` in the audit log without a duplicate
 * emit from the api wrapper.
 *
 * Thin wrapper over `deleteEntryCore` (open → core → mirrors → close);
 * behavior is byte-identical to the pre-split implementation for every
 * existing caller.
 */
export function deleteEntry(
  hippoRoot: string,
  id: string,
  opts?: { actor?: string; reason?: string; automatic?: boolean },
): boolean {
  const db = openStore(hippoRoot);
  try {
    return deleteEntryOn(db, hippoRoot, id, opts);
  } finally {
    closeHippoDb(db);
  }
}

/** deleteEntry on the caller's open store, so a loop of deletes opens the store once; each delete still commits alone. */
export function deleteEntryOn(
  db: DatabaseSyncLike,
  hippoRoot: string,
  id: string,
  opts?: { actor?: string; reason?: string; automatic?: boolean },
): boolean {
  db.exec('BEGIN IMMEDIATE');
  let result: ReturnType<typeof deleteEntryCore>;
  try {
    result = deleteEntryCore(db, id, opts);
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction !== false) db.exec('ROLLBACK');
    throw err;
  }
  if (!result) return false;

  purgeMirrorBestEffort(hippoRoot, id, false, 'deleteEntry');
  return true;
}

// The child fields a level-2/3 summary is built from (loadChildrenOfSummary, generateDagSummary).
const SUMMARY_INPUTS = ['content', 'created', 'dag_parent_id', 'kind'] as const;

function mergeOwnChanges(base: MemoryEntry, ours: MemoryEntry, live: MemoryEntry): MemoryEntry {
  const row: MemoryEntry = { ...live };
  const loaded = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(ours)) {
    if (JSON.stringify(value) !== JSON.stringify(loaded.get(key))) Object.assign(row, { [key]: value });
  }
  return row;
}

/** Consolidation's flush, one transaction. With `snapshot` (rows as the caller loaded them), a write keeps only
 *  the fields the caller changed, takes the rest from the live row, and never resurrects a row that is gone.
 *
 *  `dormant` (src/dormant.ts): each move's snapshot is inserted into `dormant_memories` and its `memories` row
 *  leaves exactly like a delete (FTS row, DAG parent dirty-mark, mirrors), in the same transaction, so a memory
 *  is never in both places or in neither. Deletes and moves both skip rows that are no longer auto-deletable
 *  (pinned, raw, kept for good or backing an object since the caller decided). Returns the ids that left `memories`, deleted or moved. */
export function batchWriteAndDelete(
  hippoRoot: string,
  toWrite: MemoryEntry[],
  toDeleteIds: string[],
  opts?: { snapshot?: ReadonlyMap<string, MemoryEntry>; dormant?: DormantMove[] },
): string[] {
  const dormantMoves = opts?.dormant ?? [];
  if (toWrite.length === 0 && toDeleteIds.length === 0 && dormantMoves.length === 0) return [];

  const db = openStore(hippoRoot);
  try {
    // IMMEDIATE: the tombstone probes below read before the first write, and under a deferred BEGIN a
    // concurrent `hippo reject` would make the lock upgrade fail with SQLITE_BUSY and roll back the batch.
    db.exec('BEGIN IMMEDIATE');
    // Snapshot every doomed row's dag_parent_id before the deletes: consolidation flushes through here
    // every cycle, so without it parents would never be marked dirty for decay, merge or garbage-collect.
    const dirty: DirtyParents = { parents: new Set<string>(), tenantById: new Map<string, string>() };
    const deletableIds: string[] = [];
    if (toDeleteIds.length > 0) {
      // A row pinned after the caller decided to delete it survives.
      for (const row of selectAutoDeletableRows(db, toDeleteIds, dirty)) deletableIds.push(row.id);
    }
    // v39: batch writers bypass writeEntry, so stamp store-derived origins here too (a NULL origin hides new
    // memories from ambient context). A row queued twice keeps only its last version, the one the merge compares.
    const stampedWrites = [...new Map(toWrite.map((e) => [e.id, stampOriginProject(hippoRoot, e)])).values()];
    const { written, batchRejectedSkips } = applyBatchWrites(db, stampedWrites, opts?.snapshot, dirty);
    const removedIds = moveDormantAndDelete(db, dormantMoves, deletableIds, dirty);
    // Fire dirty-mark for every collected parent INSIDE the BEGIN, so the
    // dirty flag commits atomically with the writes + deletes.
    for (const parentId of dirty.parents) {
      markSummaryDirtyInTx(db, parentId, dirty.tenantById.get(parentId) ?? 'default', 'batch');
    }
    db.exec('COMMIT');

    if (batchRejectedSkips > 0) {
      log.warn(
        `batchWriteAndDelete: skipped ${batchRejectedSkips} write(s) whose content matches a rejected value (tombstone hit during the batch transaction)`,
      );
    }

    // Sync mirrors once after all DB writes. Entries skipped above were
    // never inserted — writing their markdown mirror would resurrect the
    // exact content the skip just kept out of the DB.
    mirrorBestEffort('markdown mirrors', () => {
      for (const entry of written) writeMarkdownMirror(hippoRoot, entry);
    });
    for (const id of removedIds) purgeMirrorBestEffort(hippoRoot, id, false, 'batchWriteAndDelete');
    return removedIds;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    closeHippoDb(db);
  }
}

/** Moves eligible dormant rows out, deletes them with the doomed rows, and returns every removed id. */
function moveDormantAndDelete(
  db: DatabaseSyncLike,
  dormantMoves: DormantMove[],
  deletableIds: string[],
  dirty: DirtyParents,
): string[] {
  // Dormant moves: same eligibility and DAG bookkeeping as deletes.
  const movable: DormantMove[] = [];
  if (dormantMoves.length > 0) {
    const byId = new Map(dormantMoves.map((m) => [m.entry.id, m]));
    for (const row of selectAutoDeletableRows(db, [...byId.keys()], dirty)) movable.push(byId.get(row.id)!);
  }
  for (const move of movable) {
    insertDormantRow(db, move);
  }
  const removedIds = [...deletableIds, ...movable.map((m) => m.entry.id)];
  for (const id of removedIds) {
    db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    deleteFtsRow(db, id);
  }
  return removedIds;
}

/** DAG parents to mark dirty inside the batch transaction, with the tenant each belongs to. */
interface DirtyParents {
  parents: Set<string>;
  tenantById: Map<string, string>;
}

/** The still auto-deletable rows among `ids`, recording each one's DAG parent as dirty. Placeholders come from `ids` itself. */
function selectAutoDeletableRows(
  db: DatabaseSyncLike,
  ids: string[],
  dirty: DirtyParents,
): Array<{ id: string; dag_parent_id: string | null; tenant_id: string | null }> {
  // SAFETY: rows' shape matches the three columns named in the SELECT.
  const rows = db.prepare(
    `SELECT id, dag_parent_id, tenant_id FROM memories WHERE id IN (${ids.map(() => '?').join(',')}) AND ${AUTOMATIC_DELETE_SQL}`,
  ).all(...ids) as Array<{ id: string; dag_parent_id: string | null; tenant_id: string | null }>;
  for (const row of rows) {
    if (row.dag_parent_id) {
      dirty.parents.add(row.dag_parent_id);
      dirty.tenantById.set(row.dag_parent_id, row.tenant_id ?? 'default');
    }
  }
  return rows;
}

function applyBatchWrites(
  db: DatabaseSyncLike,
  stampedWrites: MemoryEntry[],
  snapshot: ReadonlyMap<string, MemoryEntry> | undefined,
  dirty: DirtyParents,
) {
  // Probe tombstones per entry on THIS connection inside the transaction: the producer's check ran earlier
  // on another connection, so a reject committed in between would be re-inserted. Skip, never throw, so the rest lands.
  let batchRejectedSkips = 0;
  const written: MemoryEntry[] = [];
  const readLiveRow = db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ?`);
  for (const entry of stampedWrites) {
    const base = snapshot?.get(entry.id);
    // SAFETY: MEMORY_SELECT_COLUMNS is the MemoryRow shape rowToEntry reads.
    const liveRow = readLiveRow.get(entry.id) as MemoryRow | undefined;
    const live = liveRow ? rowToEntry(liveRow) : undefined;
    const row = base && live ? mergeOwnChanges(base, entry, live) : entry;
    if (isRejectedBatchWrite(db, row)) {
      batchRejectedSkips++;
      continue;
    }
    if (base && !live) continue;
    written.push(row);
    // Bypass the guard: merges concatenate already-guarded facts, the merge pass checks merged content, and
    // the probe above closes the race; a mid-batch refusal would abort the whole consolidation.
    upsertEntryRow(db, row, true);
    // Hook for writes: a new child, or a change to what its summary reads, marks the parent dirty; decay alone does not.
    if (row.dag_parent_id && (!live || SUMMARY_INPUTS.some((k) => row[k] !== live[k]))) {
      dirty.parents.add(row.dag_parent_id);
      dirty.tenantById.set(row.dag_parent_id, row.tenantId);
    }
  }
  return { written, batchRejectedSkips };
}

/** True, after auditing the refusal, when the write would introduce a rejected value. */
function isRejectedBatchWrite(db: DatabaseSyncLike, row: MemoryEntry): boolean {
  const entryTenantId = row.tenantId ?? 'default';
  // checkRejectionGuard, not a bare tombstone probe: a tombstone can coexist with a live same-content row,
  // and skipping every re-persist would starve it of decay/replay updates; only new or changed content is refused.
  try {
    checkRejectionGuard(db, entryTenantId, row.id, row.content);
  } catch (err) {
    if (err instanceof RejectedValueError) {
      audit(
        db,
        'reject_refusal',
        row.id,
        { digest: err.digest, reason: err.reason },
        'sleep-batch',
        entryTenantId,
      );
      return true;
    }
    throw err;
  }
  return false;
}
