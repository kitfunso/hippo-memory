import { type MemoryEntry, markRetrieved } from '../memory.js';
import { type DatabaseSyncLike, closeHippoDb, openHippoDb } from '../db.js';
import { RejectedValueError } from '../rejection.js';
import { markSummaryDirtyInTx } from '../summary-dirty.js';
import { log } from '../log.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './rows.js';
import { auditRejectionRefusal, audit } from './audit-event.js';
import { stampOriginProject, upsertEntryRow, syncFtsRow, deleteFtsRow } from './entry-row.js';
import { mirrorBestEffort, writeMarkdownMirror } from './mirrors.js';
import { openStore } from './open.js';

export interface WriteEntryOptions {
  actor?: string;
  afterWrite?: (db: DatabaseSyncLike, memoryId: string) => void;
  /** Runs after the row commits and before the mirrors, on an idle connection; keep it best-effort. */
  afterCommit?: () => void;
}

export function writeEntry(hippoRoot: string, entry: MemoryEntry, opts?: WriteEntryOptions): void {
  const db = openStore(hippoRoot);
  try {
    writeEntryOn(db, hippoRoot, entry, opts);
  } finally {
    closeHippoDb(db);
  }
}

/** writeEntry on the caller's open store, so a loop of writes opens the store once; each row still commits alone. */
export function writeEntryOn(db: DatabaseSyncLike, hippoRoot: string, entry: MemoryEntry, opts?: WriteEntryOptions): void {
  try {
    const stamped = stampOriginProject(hippoRoot, entry);
    writeEntryDbOnly(db, stamped, opts);
    opts?.afterCommit?.();
    writeEntryMirrors(hippoRoot, stamped);
  } catch (error) {
    // AT1 (plan §3): writeEntryDbOnly's own SAVEPOINT has already unwound by
    // the time this catch runs, so the refusal audit lands post-rollback in
    // a fresh implicit transaction — then rethrow so the caller sees the
    // refusal.
    if (error instanceof RejectedValueError) {
      auditRejectionRefusal(db, error, opts?.actor ?? 'cli');
    }
    throw error;
  }
}

/**
 * DB-only write path. Caller owns the open `db` handle. Runs SAVEPOINT +
 * upsert + afterWrite hook + audit row inside the SAVEPOINT scope. Caller
 * is responsible for opening `db`, optionally wrapping in a larger BEGIN/
 * COMMIT (e.g. supersede's BEGIN IMMEDIATE), closing `db`, AND calling
 * `writeEntryMirrors` after the larger tx commits — mirrors must run
 * post-commit so a rolled-back tx never leaves orphan markdown.
 *
 * Audit-order note: the audit row is emitted INSIDE the SAVEPOINT, so audit
 * commits atomically with the row INSERT. A subsequent mirror failure cannot
 * leave a recorded audit entry without its corresponding DB row. This is a
 * documented hardening over the prior writeEntry-as-monolith ordering.
 */
export function writeEntryDbOnly(
  db: DatabaseSyncLike,
  entry: MemoryEntry,
  opts?: {
    actor?: string;
    afterWrite?: (db: DatabaseSyncLike, memoryId: string) => void;
  },
): void {
  // SAVEPOINT (not BEGIN) so this nests safely inside any outer transaction
  // a caller might hold (e.g. supersede's BEGIN IMMEDIATE). SQLite refuses
  // BEGIN within a transaction; SAVEPOINT is the only way to scope rollback
  // without disturbing outers.
  db.exec('SAVEPOINT write_entry');
  try {
    upsertEntryRow(db, entry);
    if (opts?.afterWrite) {
      opts.afterWrite(db, entry.id);
    }
    audit(
      db,
      'remember',
      entry.id,
      {
        kind: entry.kind ?? 'distilled',
        scope: entry.scope ?? null,
      },
      opts?.actor ?? 'cli',
      entry.tenantId,
    );
    // v0.30 / E2 — DAG live-coupling: child write under a level-2 summary
    // marks the parent dirty for E3 sleep-cycle rebuild. Early-exit on
    // null dag_parent_id (vast majority of writes); cost is one null check
    // on the hot path.
    if (entry.dag_parent_id) {
      markSummaryDirtyInTx(db, entry.dag_parent_id, entry.tenantId, opts?.actor ?? 'cli');
    }
    db.exec('RELEASE SAVEPOINT write_entry');
  } catch (e) {
    try {
      db.exec('ROLLBACK TO SAVEPOINT write_entry');
      db.exec('RELEASE SAVEPOINT write_entry');
    } catch {
      // Ignore rollback failures — the throw below is what matters.
    }
    throw e;
  }
}

/** Markdown mirror path, invoked AFTER commit (a rolled-back tx must leave no orphan markdown). */
export function writeEntryMirrors(hippoRoot: string, entry: MemoryEntry): void {
  mirrorBestEffort(`${entry.id}.md`, () => writeMarkdownMirror(hippoRoot, entry));
}

/** The caller passes the eval-only recall-boost ablation switch, so the store never reads experiment config itself. */
export interface StrengthenOptions {
  readonly tenantId?: string;
  readonly recallBoostAblated: boolean;
}

/** Strengthen what a read returned: update only the four retrieval columns on the live row, never a stale copy.
 *  Best effort: a failure logs and never fails the read. Returns the ids found in this store. */
export function strengthenRetrieved(hippoRoot: string, ids: readonly string[], opts: StrengthenOptions): Set<string> {
  const found = new Set<string>();
  if (ids.length === 0 || opts.recallBoostAblated) return found;
  let db: DatabaseSyncLike | undefined;
  try {
    db = openHippoDb(hippoRoot);
    db.exec('BEGIN IMMEDIATE');
    for (const id of strengthenRetrievedOn(db, ids, opts)) found.add(id);
    db.exec('COMMIT');
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* already rolled back; keep the original error */ }
    log.warn(`retrieval stats not saved (${error instanceof Error ? error.message : String(error)})`);
    found.clear();
  } finally {
    if (db) closeHippoDb(db);
  }
  return found;
}

/** strengthenRetrieved on the caller's handle, inside the caller's transaction. Throws; the caller decides. */
export function strengthenRetrievedOn(db: DatabaseSyncLike, ids: readonly string[], opts: StrengthenOptions): Set<string> {
  const found = new Set<string>();
  if (ids.length === 0 || opts.recallBoostAblated) return found;
  const { tenantId } = opts;
  const tenantClause = tenantId !== undefined ? ' AND tenant_id = ?' : '';
  const select = db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ?${tenantClause}`);
  const live: MemoryEntry[] = [];
  for (const id of ids) {
    // SAFETY: the SELECT names exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
    const row = (tenantId !== undefined ? select.get(id, tenantId) : select.get(id)) as MemoryRow | undefined;
    if (row) live.push(rowToEntry(row));
  }
  const update = db.prepare(
    'UPDATE memories SET retrieval_count = ?, last_retrieved = ?, half_life_days = ?, strength = ? WHERE id = ?',
  );
  for (const e of markRetrieved(live)) {
    update.run(e.retrieval_count, e.last_retrieved, e.half_life_days, e.strength, e.id);
    found.add(e.id);
  }
  return found;
}

/** Rewrites a live row's tags and its full-text row on the caller's transaction, with no audit row. */
export function setEntryTagsInTx(db: DatabaseSyncLike, entry: MemoryEntry): void {
  db.prepare(`UPDATE memories SET tags_json = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`)
    .run(JSON.stringify(entry.tags), entry.id, entry.tenantId);
  syncFtsRow(db, entry);
}

/** Removes a row from `memories` and full-text search on the caller's transaction, as sleep's dormant move does, and marks its summary parent dirty. */
export function deleteEntryRowInTx(db: DatabaseSyncLike, entry: MemoryEntry, actor: string): void {
  db.prepare('DELETE FROM memories WHERE id = ? AND tenant_id = ?').run(entry.id, entry.tenantId);
  deleteFtsRow(db, entry.id);
  if (entry.dag_parent_id) markSummaryDirtyInTx(db, entry.dag_parent_id, entry.tenantId, actor);
}
