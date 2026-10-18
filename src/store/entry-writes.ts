import { strengthAblation } from '../core/ablation.js';
import { type MemoryEntry, markRetrieved } from '../core/memory.js';
import { type DatabaseSyncLike, closeHippoDb, openHippoDb, withWriteScope } from '../db/index.js';
import { rethrowIfSqliteBlocked } from '../util/sqlite-blocked.js';
import { chunked } from '../util/chunked.js';
import { RejectedValueError } from '../core/api-errors.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import { errorMessage, log } from '../util/log.js';
import { auditRejectionRefusal, audit } from './audit-event.js';
import { appendAuditEvent } from './audit.js';
import { selectEntriesByIds } from './entry-reads.js';
import { stampOriginProject, upsertEntryRow, syncFtsRow, deleteFtsRow } from './entry-row.js';
import { mirrorBestEffort, writeMarkdownMirror } from './mirrors.js';
import { onHandle, openStore, type StoreFiles } from './open.js';
import { CLI_ACTOR } from '../core/actor.js';
import type { RenameSourceOptions } from './port/agent-import.js';
import type { StrengthenOptions } from './port/recall-writes.js';

export interface WriteEntryOptions {
  actor?: string;
  /** Runs after the row commits and before the mirrors, on an idle connection; keep it best-effort. */
  afterCommit?: () => void;
}

/** Store-side only, never exported from a package entry: `afterWrite` hands the write's own db handle to the hook. */
export interface WriteEntryInternalOptions extends WriteEntryOptions {
  /** Runs in the same SAVEPOINT as the INSERT, so a throw rolls the row back. */
  afterWrite?: (db: DatabaseSyncLike, memoryId: string) => void;
}

/** Write an entry to SQLite and refresh mirrors. `opts.actor` defaults to 'cli'; the api layer passes the resolved
 * actor, so the audit log gets one row per write. */
export function writeEntry(hippoRoot: string, entry: MemoryEntry, opts?: WriteEntryOptions): void {
  onHandle(hippoRoot, (db) => writeEntryAt(db, { hippoRoot }, entry, opts), openStore);
}

/** Writes a promoted copy; with `auditAs` the `promote` audit row joins the INSERT's SAVEPOINT, so both or neither. */
export function writePromotedEntry(
  hippoRoot: string,
  entry: MemoryEntry,
  opts: { readonly actor?: string; readonly sourceId: string; readonly auditAs?: { tenantId: string; actor: string } },
): void {
  const { auditAs, sourceId } = opts;
  const afterWrite =
    auditAs &&
    ((db: DatabaseSyncLike, globalId: string) => {
      appendAuditEvent(db, {
        tenantId: auditAs.tenantId,
        actor: auditAs.actor,
        op: 'promote',
        targetId: globalId,
        metadata: { sourceId },
      });
    });
  onHandle(hippoRoot, (db) => writeEntryAt(db, { hippoRoot }, entry, { actor: opts.actor, afterWrite }), openStore);
}

/** writeEntry for each of `entries` in one transaction, so all land or none; each
 * keeps its audit row, and mirrors follow the commit. Returns how many were written; an empty list opens no store. */
export function writeEntriesTogetherAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entries: readonly MemoryEntry[],
): number {
  const stamped = entries.map((entry) => stampOriginProject(files.hippoRoot, entry));
  try {
    withWriteScope(db, 'write_entries_together', () => {
      for (const entry of stamped) writeEntryDbOnly(db, entry);
    });
    for (const entry of stamped) writeEntryMirrors(files.hippoRoot, entry);
  } catch (error) {
    // The scope has unwound, so the refusal row outlives the rollback, as writeEntryAt's does.
    if (error instanceof RejectedValueError) auditRejectionRefusal(db, error, CLI_ACTOR);
    throw error;
  }
  return stamped.length;
}

/** Runs `fill` in one transaction; each `put` writes one entry and returns false when the store rejects its value,
 * leaving that row's refusal audit and the rest of the batch. Mirrors follow the commit. Returns how many were
 * written. */
export function writeEntriesSkippingRejectedAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  fill: (put: (entry: MemoryEntry) => boolean) => void,
  actor = CLI_ACTOR,
): number {
  const written: MemoryEntry[] = [];
  withWriteScope(db, 'write_entries_skipping_rejected', () => {
    fill((entry) => {
      const stamped = stampOriginProject(files.hippoRoot, entry);
      try {
        writeEntryDbOnly(db, stamped, { actor });
      } catch (error) {
        if (!(error instanceof RejectedValueError)) throw error;
        auditRejectionRefusal(db, error, actor);
        return false;
      }
      written.push(stamped);
      return true;
    });
  });
  for (const entry of written) writeEntryMirrors(files.hippoRoot, entry);
  return written.length;
}

/** Adds `tag` to each of a tenant's rows that lacks it, in `ids` order, all in one transaction; an id the tenant does
 * not hold is skipped. */
export function addTagToEntriesAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  ids: readonly string[],
  tag: string,
): void {
  const live = selectEntriesByIds(db, ids, tenantId);
  const tagged = [...new Set(ids)].flatMap((id) => {
    const entry = live.get(id);
    return !entry || entry.tags.includes(tag) ? [] : [{ ...entry, tags: [...entry.tags, tag] }];
  });
  if (tagged.length > 0) writeEntriesTogetherAt(db, files, tagged);
}

/** writeEntry on the caller's open store, so a loop of writes opens the store once; each row still commits alone.
 * `opts.afterWrite` shares the INSERT's SAVEPOINT. */
export function writeEntryAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entry: MemoryEntry,
  opts?: WriteEntryInternalOptions,
): void {
  try {
    const stamped = stampOriginProject(files.hippoRoot, entry);
    writeEntryDbOnly(db, stamped, opts);
    opts?.afterCommit?.();
    writeEntryMirrors(files.hippoRoot, stamped);
  } catch (error) {
    // writeEntryDbOnly's write scope has already unwound here, so the refusal audit lands
    // post-rollback in a fresh implicit transaction; then rethrow so the caller sees it.
    if (error instanceof RejectedValueError) {
      auditRejectionRefusal(db, error, opts?.actor ?? CLI_ACTOR);
    }
    throw error;
  }
}

/** DB-only write path: upsert, afterWrite hook and audit row inside one withWriteScope; the caller owns `db` and must
 * call `writeEntryMirrors` after any outer tx commits, so a rolled-back tx never leaves orphan markdown. The audit row
 * commits atomically with the INSERT. */
export function writeEntryDbOnly(
  db: DatabaseSyncLike,
  entry: MemoryEntry,
  opts?: Pick<WriteEntryInternalOptions, 'actor' | 'afterWrite'>,
): void {
  // Inside a caller's transaction (e.g. supersede's BEGIN IMMEDIATE) the scope is a SAVEPOINT,
  // so a throw here rolls back only this write and leaves the outer open.
  withWriteScope(db, 'write_entry', () => {
    upsertEntryRow(db, entry);
    if (opts?.afterWrite) {
      opts.afterWrite(db, entry.id);
    }
    auditEntryWrite(db, entry, opts?.actor ?? CLI_ACTOR);
  });
}

/** What follows a row's upsert inside its write scope: the remember row, last of the write's audit rows, then the
 * summary parent's dirty mark. */
export function auditEntryWrite(db: DatabaseSyncLike, entry: MemoryEntry, actor: string): void {
  const tenantId = entry.tenant_id;
  audit(db, 'remember', { targetId: entry.id, metadata: rememberAuditMetadata(entry), actor, tenantId });
  // A child write marks its summary parent dirty for the sleep-cycle rebuild; most writes
  // have no parent, so the hot path pays one null check.
  if (entry.dag_parent_id) {
    markSummaryDirtyInTx(db, entry.dag_parent_id, entry.tenant_id, actor);
  }
}

/** What a row write's `remember` audit row records. */
export function rememberAuditMetadata(entry: MemoryEntry) {
  return { kind: entry.kind ?? 'distilled', scope: entry.scope ?? null };
}

/** Markdown mirror path, invoked AFTER commit (a rolled-back tx must leave no orphan markdown). */
export function writeEntryMirrors(hippoRoot: string, entry: MemoryEntry): void {
  mirrorBestEffort(`${entry.id}.md`, () => writeMarkdownMirror(hippoRoot, entry));
}

export function writeEntryMirrorsIn(files: StoreFiles, entry: MemoryEntry): void {
  writeEntryMirrors(files.hippoRoot, entry);
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

/** strengthenRetrieved on an open handle in its own write scope, a savepoint inside a caller's transaction, so a
 * recall's last writes share one handle. */
export function strengthenRetrievedInOwnTx(
  db: DatabaseSyncLike,
  ids: readonly string[],
  opts: StrengthenOptions,
): Set<string> {
  if (ids.length === 0 || opts.recallBoostAblated) return new Set();
  try {
    return withWriteScope(db, 'strengthen_retrieved', () => strengthenRetrievedOn(db, ids, opts));
  } catch (error) {
    warnStrengthenFailed(error);
    return new Set();
  }
}

function warnStrengthenFailed<E>(error: E): void {
  log.warn(`retrieval stats not saved (${errorMessage(error)})`);
}

/** Rows per recall-write statement: five bound values each, far under SQLite's parameter limit. */
const RETRIEVAL_UPDATE_CHUNK = 100;

/** strengthenRetrieved on the caller's handle, inside the caller's transaction. Throws; the caller decides. */
export function strengthenRetrievedOn(
  db: DatabaseSyncLike,
  ids: readonly string[],
  opts: StrengthenOptions,
): Set<string> {
  const found = new Set<string>();
  if (ids.length === 0 || opts.recallBoostAblated) return found;
  const byId = selectEntriesByIds(db, ids, opts.tenantId);
  const live = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
  const updated = markRetrieved(live, undefined, { ablation: strengthAblation() });
  // One UPDATE ... FROM per chunk of rows instead of one statement per row.
  for (const chunk of chunked(updated, RETRIEVAL_UPDATE_CHUNK)) {
    const values = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
    db.prepare(
      `WITH v(id, rc, lr, hl, st) AS (VALUES ${values})
       UPDATE memories SET retrieval_count = v.rc, last_retrieved = v.lr, half_life_days = v.hl, strength = v.st
       FROM v WHERE memories.id = v.id`,
    ).run(...chunk.flatMap((e) => [e.id, e.retrieval_count, e.last_retrieved, e.half_life_days, e.strength]));
    for (const e of chunk) found.add(e.id);
  }
  return found;
}

/** Rewrites a live row's tags and its full-text row on the caller's transaction, with no audit row. */
export function setEntryTagsInTx(db: DatabaseSyncLike, entry: MemoryEntry): void {
  db.prepare(`UPDATE memories SET tags_json = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`).run(
    JSON.stringify(entry.tags),
    entry.id,
    entry.tenant_id,
  );
  syncFtsRow(db, entry);
}

/** Removes a row from `memories` and full-text search on the caller's transaction, as sleep's dormant move does, and
 * marks its summary parent dirty. */
export function deleteEntryRowInTx(db: DatabaseSyncLike, entry: MemoryEntry, actor: string): void {
  db.prepare('DELETE FROM memories WHERE id = ? AND tenant_id = ?').run(entry.id, entry.tenant_id);
  deleteFtsRow(db, entry.id);
  if (entry.dag_parent_id) markSummaryDirtyInTx(db, entry.dag_parent_id, entry.tenant_id, actor);
}

/** One half-life per memory id, on the caller's transaction. */
export function setHalfLivesAt(db: DatabaseSyncLike, rows: readonly { id: string; halfLifeDays: number }[]): void {
  const update = db.prepare('UPDATE memories SET half_life_days = ? WHERE id = ?');
  for (const r of rows) update.run(r.halfLifeDays, r.id);
}

/** Moves every row of `from` in a tenant to project `into`. */
export function restampOriginProjectAt(db: DatabaseSyncLike, tenantId: string, from: string, into: string): void {
  db.prepare(
    `UPDATE memories SET origin_project = ?, updated_at = datetime('now') WHERE tenant_id = ? AND origin_project = ?`,
  ).run(into, tenantId, from);
}

/** Stamps each id with its project. */
export function stampOriginProjectsAt(
  db: DatabaseSyncLike,
  tenantId: string,
  rows: readonly { id: string; origin: string }[],
): void {
  const stamp = db.prepare(
    `UPDATE memories SET origin_project = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`,
  );
  for (const { id, origin } of rows) stamp.run(origin, tenantId, id);
}

/** Renames a live row's source from `from` to `to`; the count is 0 when another writer moved or superseded it first. */
export function renameEntrySourceAt(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  from: string,
  to: string,
): number {
  const moved = db
    .prepare(`UPDATE memories SET source = ? WHERE id = ? AND tenant_id = ? AND source = ? AND superseded_by IS NULL`)
    .run(to, id, tenantId, from);
  return Number(moved.changes ?? 0);
}

/** Renames a row's source and, when `origin` is not null, its project; the count is 0 when the row is gone or moved. */
export function renameEntrySourceAndOriginAt(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  options: RenameSourceOptions,
): number {
  const { from, to, origin } = options;
  const done = db
    .prepare(
      `UPDATE memories SET source = ?, origin_project = COALESCE(?, origin_project) WHERE id = ? AND tenant_id = ? ` +
        `AND source = ?`,
    )
    .run(to, origin, id, tenantId, from);
  return Number(done.changes ?? 0);
}

/** Marks `id` superseded by `newId`; false when another writer superseded it first. */
export function supersedeEntryAt(db: DatabaseSyncLike, tenantId: string, id: string, newId: string): boolean {
  const result = db
    .prepare(`UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL`)
    .run(newId, id, tenantId);
  return Number(result.changes ?? 0) !== 0;
}
