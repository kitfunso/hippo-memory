import { type MemoryEntry, markRetrieved } from '../memory.js';
import { type DatabaseSyncLike, closeHippoDb, openHippoDb, rethrowIfSqliteBlocked, withWriteScope } from '../db.js';
import { RejectedValueError } from '../rejection.js';
import { markSummaryDirtyInTx } from '../summary-dirty.js';
import { log } from '../log.js';
import { auditRejectionRefusal, audit } from './audit-event.js';
import { selectEntriesByIds } from './entry-reads.js';
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

/** writeEntry for each of `entries` in one transaction, so all land or none; each keeps its audit row, and mirrors follow the commit. Returns how many were written. */
export function writeEntriesTogether(hippoRoot: string, entries: readonly MemoryEntry[]): number {
  const stamped = entries.map((entry) => stampOriginProject(hippoRoot, entry));
  const db = openStore(hippoRoot);
  try {
    withWriteScope(db, 'write_entries_together', () => {
      for (const entry of stamped) writeEntryDbOnly(db, entry);
    });
    for (const entry of stamped) writeEntryMirrors(hippoRoot, entry);
  } catch (error) {
    // The scope has unwound, so the refusal row outlives the rollback, as writeEntryOn's does.
    if (error instanceof RejectedValueError) auditRejectionRefusal(db, error, 'cli');
    throw error;
  } finally {
    closeHippoDb(db);
  }
  return stamped.length;
}

/** writeEntry on the caller's open store, so a loop of writes opens the store once; each row still commits alone. */
export function writeEntryOn(db: DatabaseSyncLike, hippoRoot: string, entry: MemoryEntry, opts?: WriteEntryOptions): void {
  try {
    const stamped = stampOriginProject(hippoRoot, entry);
    writeEntryDbOnly(db, stamped, opts);
    opts?.afterCommit?.();
    writeEntryMirrors(hippoRoot, stamped);
  } catch (error) {
    // writeEntryDbOnly's write scope has already unwound here, so the refusal audit lands
    // post-rollback in a fresh implicit transaction; then rethrow so the caller sees it.
    if (error instanceof RejectedValueError) {
      auditRejectionRefusal(db, error, opts?.actor ?? 'cli');
    }
    throw error;
  }
}

/**
 * DB-only write path. Caller owns the open `db` handle. Runs upsert +
 * afterWrite hook + audit row inside one withWriteScope. Caller
 * is responsible for opening `db`, optionally wrapping in a larger BEGIN/
 * COMMIT (e.g. supersede's BEGIN IMMEDIATE), closing `db`, AND calling
 * `writeEntryMirrors` after the larger tx commits — mirrors must run
 * post-commit so a rolled-back tx never leaves orphan markdown.
 *
 * Audit-order note: the audit row is emitted INSIDE the write scope, so audit
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
  // Inside a caller's transaction (e.g. supersede's BEGIN IMMEDIATE) the scope is a SAVEPOINT,
  // so a throw here rolls back only this write and leaves the outer open.
  withWriteScope(db, 'write_entry', () => {
    upsertEntryRow(db, entry);
    if (opts?.afterWrite) {
      opts.afterWrite(db, entry.id);
    }
    audit(db, 'remember', { targetId: entry.id, metadata: {
        kind: entry.kind ?? 'distilled',
        scope: entry.scope ?? null,
      }, actor: opts?.actor ?? 'cli', tenantId: entry.tenantId });
    // A child write marks its summary parent dirty for the sleep-cycle rebuild; most writes
    // have no parent, so the hot path pays one null check.
    if (entry.dag_parent_id) {
      markSummaryDirtyInTx(db, entry.dag_parent_id, entry.tenantId, opts?.actor ?? 'cli');
    }
  });
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
  if (ids.length === 0 || opts.recallBoostAblated) return new Set();
  let db: DatabaseSyncLike;
  try {
    db = openHippoDb(hippoRoot);
  } catch (error) {
    rethrowIfSqliteBlocked(error);
    warnStrengthenFailed(error);
    return new Set();
  }
  try {
    return strengthenRetrievedInOwnTx(db, ids, opts);
  } finally {
    closeHippoDb(db);
  }
}

/** strengthenRetrieved on an open handle that holds no transaction, so a recall's last writes share one handle. */
export function strengthenRetrievedInOwnTx(db: DatabaseSyncLike, ids: readonly string[], opts: StrengthenOptions): Set<string> {
  if (ids.length === 0 || opts.recallBoostAblated) return new Set();
  try {
    return withWriteScope(db, 'strengthen_retrieved', () => strengthenRetrievedOn(db, ids, opts));
  } catch (error) {
    warnStrengthenFailed(error);
    return new Set();
  }
}

function warnStrengthenFailed<E>(error: E): void {
  log.warn(`retrieval stats not saved (${error instanceof Error ? error.message : String(error)})`);
}

/** strengthenRetrieved on the caller's handle, inside the caller's transaction. Throws; the caller decides. */
export function strengthenRetrievedOn(db: DatabaseSyncLike, ids: readonly string[], opts: StrengthenOptions): Set<string> {
  const found = new Set<string>();
  if (ids.length === 0 || opts.recallBoostAblated) return found;
  const byId = selectEntriesByIds(db, ids, opts.tenantId);
  const live = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
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

/** One half-life per memory id, on the caller's transaction. */
export function setHalfLivesAt(db: DatabaseSyncLike, rows: readonly { id: string; halfLifeDays: number }[]): void {
  const update = db.prepare('UPDATE memories SET half_life_days = ? WHERE id = ?');
  for (const r of rows) update.run(r.halfLifeDays, r.id);
}

/** Moves every row of `from` in a tenant to project `into`. */
export function restampOriginProjectAt(db: DatabaseSyncLike, tenantId: string, from: string, into: string): void {
  db.prepare(`UPDATE memories SET origin_project = ?, updated_at = datetime('now') WHERE tenant_id = ? AND origin_project = ?`)
    .run(into, tenantId, from);
}

/** Stamps each id with its project. */
export function stampOriginProjectsAt(db: DatabaseSyncLike, tenantId: string, rows: readonly { id: string; origin: string }[]): void {
  const stamp = db.prepare(`UPDATE memories SET origin_project = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`);
  for (const { id, origin } of rows) stamp.run(origin, tenantId, id);
}

/** Renames a live row's source from `from` to `to`; the count is 0 when another writer moved or superseded it first. */
export function renameEntrySourceAt(db: DatabaseSyncLike, tenantId: string, id: string, from: string, to: string): number {
  const moved = db.prepare(
    `UPDATE memories SET source = ? WHERE id = ? AND tenant_id = ? AND source = ? AND superseded_by IS NULL`,
  ).run(to, id, tenantId, from);
  return Number(moved.changes ?? 0);
}

export interface RenameSourceOptions {
  readonly from: string;
  readonly to: string;
  readonly origin: string | null;
}

/** Renames a row's source and, when `origin` is not null, its project; the count is 0 when the row is gone or moved. */
export function renameEntrySourceAndOriginAt(
  db: DatabaseSyncLike, tenantId: string, id: string, options: RenameSourceOptions,
): number {
  const { from, to, origin } = options;
  const done = db.prepare(
    `UPDATE memories SET source = ?, origin_project = COALESCE(?, origin_project) WHERE id = ? AND tenant_id = ? AND source = ?`,
  ).run(to, origin, id, tenantId, from);
  return Number(done.changes ?? 0);
}

/** Marks `id` superseded by `newId`; false when another writer superseded it first. */
export function supersedeEntryAt(db: DatabaseSyncLike, tenantId: string, id: string, newId: string): boolean {
  const result = db.prepare(`UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL`)
    .run(newId, id, tenantId);
  return Number(result.changes ?? 0) !== 0;
}
