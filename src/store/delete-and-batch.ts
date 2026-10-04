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
 * AT1 (plan §4, round-2 fix, designed from source): db-scoped delete core.
 * `deleteEntry` used to open+close its OWN connection, which meant it could
 * never compose inside a caller's transaction (unlike writeEntry/
 * writeEntryDbOnly, which already split this way). Split identically: row-
 * meta SELECT, `DELETE FROM memories`, FTS delete, `forget` audit, DAG
 * dirty-mark. NO filesystem I/O — the caller's own transaction may still be
 * rolled back, and mirror writes must only happen post-commit.
 *
 * `opts.suppressForgetAudit` (default false, off): two AT1 callers set this
 * so a removed non-raw row does NOT ALSO emit a `forget` row, because each
 * already writes its own aggregate audit trail — `src/reject-flow.ts`'s
 * `rejectValue` (single `reject_value` row covering every same-digest row
 * removed) and `resolveConflict` (`conflict_resolve` row per resolution).
 * Default keeps `deleteEntry` byte-identical to its pre-split behavior.
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
  // v0.30 / E2 — DAG live-coupling: forget of a child under a level-2
  // summary marks parent dirty. Non-atomic with the DELETE (no SAVEPOINT
  // wrapper here, same as pre-split deleteEntry); markSummaryDirtyInTx is
  // idempotent so any future child mutation re-marks parent if this fails.
  // Acceptable degradation, mirrors the pre-split audit best-effort posture.
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
    // BEGIN IMMEDIATE (codex delta-review P2): the AT1 tombstone probes below
    // READ before the first write. Under a deferred BEGIN, that read pins a
    // WAL snapshot; a concurrent writer (e.g. `hippo reject`) committing
    // between probe and first upsert would make the later write-lock upgrade
    // fail with SQLITE_BUSY and roll back the ENTIRE batch — the exact race
    // the probe exists to contain. Taking the write lock up front serializes
    // the probe and the writes on one consistent snapshot.
    db.exec('BEGIN IMMEDIATE');
    // v0.30 / E2 — DAG live-coupling: BEFORE deletes, snapshot dag_parent_id
    // for every doomed row so we can mark parents dirty post-COMMIT. Done
    // inside the same BEGIN so the SELECT sees pre-delete state.
    // independent-review-critic R1 HIGH: consolidate.ts/sleep flushes through
    // this path every cycle; without these hooks parents NEVER get marked
    // dirty for the dominant mutation source (decay, merge, garbage-collect).
    const dirty: DirtyParents = { parents: new Set<string>(), tenantById: new Map<string, string>() };
    const deletableIds: string[] = [];
    if (toDeleteIds.length > 0) {
      // A row pinned after the caller decided to delete it survives.
      const placeholders = toDeleteIds.map(() => '?').join(',');
      for (const row of selectAutoDeletableRows(db, placeholders, toDeleteIds, dirty)) deletableIds.push(row.id);
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
    const placeholders = dormantMoves.map(() => '?').join(',');
    for (const row of selectAutoDeletableRows(db, placeholders, [...byId.keys()], dirty)) movable.push(byId.get(row.id)!);
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

/** The still auto-deletable rows among `ids`, recording each one's DAG parent as dirty. */
function selectAutoDeletableRows(
  db: DatabaseSyncLike,
  placeholders: string,
  ids: string[],
  dirty: DirtyParents,
): Array<{ id: string; dag_parent_id: string | null; tenant_id: string | null }> {
  // SAFETY: rows' shape matches the three columns named in the SELECT.
  const rows = db.prepare(
    `SELECT id, dag_parent_id, tenant_id FROM memories WHERE id IN (${placeholders}) AND ${AUTOMATIC_DELETE_SQL}`,
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
  // AT1 P1 fix (codex, batch-transaction rejection race): the producer-side
  // check (e.g. consolidate.ts's merge pass) runs BEFORE this transaction,
  // on a different connection. A `hippo reject X` that commits in that
  // window is invisible to it — a queued same-id write of X already
  // sitting in `toWrite` (decay/replay re-persist, or a merge built before
  // the reject) would silently re-INSERT the just-rejected row via the
  // blind bypass. Fix: one indexed point probe per batch entry, on THIS
  // connection, INSIDE this transaction — closes the race regardless of
  // which write class hits it. N is small per sleep, so the extra query
  // per entry is cheap.
  //
  // Skip, don't throw: the batch must still complete for every OTHER
  // entry. Skipping is correct for every write class here — a merge
  // summary skip just means that rollup is absent this cycle (its source
  // facts stay merely demoted, recoverable next sleep); a skipped
  // demotion/replay re-persist of a rejected-removed row means it stays
  // gone, which is the entire point of the tombstone.
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
    // AT1 (plan §3, corrected): bypass the rejection guard here.
    // Consolidation merges are DETERMINISTIC CONCATENATION (mergeContents,
    // consolidate.ts:736-751) of already-guarded leaf facts, not an LLM
    // paraphrase — refusing mid-batch would abort the whole consolidation
    // transaction. The bypass is safe because consolidate.ts's merge pass
    // now checks the merged content's rejection digest against the
    // tenant's tombstones BEFORE ever pushing a merge into pendingWrites,
    // skipping that merge entirely on a hit, AND because the point-probe
    // immediately above closes the race window between that producer
    // check and this COMMIT. The guard itself still belongs on leaf
    // inserts, which write through writeEntry / writeEntryDbOnly and stay
    // guarded (bypassRejectionGuard defaults false).
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
  // Codex delta-review P2 fix: reuse checkRejectionGuard rather than a
  // bare tombstone probe — the guard's content-INTRODUCTION
  // classification must apply here too. A tombstone can legitimately
  // coexist with a live same-content row (resolveConflict deliberately
  // excludes keepId from its sweep; unreject-then-re-reject windows), and
  // an unconditional skip would starve that row of decay/replay metadata
  // updates forever. The guard throws only when the write is new-row or
  // changes content TO the rejected value; unchanged same-id re-persists
  // pass through, exactly as on the writeEntry path.
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
