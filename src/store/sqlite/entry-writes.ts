// hippo.db's EntryWrites group: the writes remember, outcome, supersede, archive and forget run, and the shared entry
// write path.
import {
  type LossAversion,
  type MemoryEntry,
  markRetrieved,
  entryAfterOutcome,
  strengthOptionsOf,
} from '../../base/memory/memory.js';
import { type DatabaseSyncLike, withWriteScope, isSqliteBusy } from '../../db/index.js';
import { RejectedValueError, ConflictError, CrossTenantIdError, NotFoundError } from '../../base/errors/api-errors.js';
import { markSummaryDirtyInTx, markSummariesDirtyInTx } from './summary-dirty.js';
import { summaryDirtyAudit } from '../rules/audit-rows.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import { auditRejectionRefusal, audit } from './audit-event.js';
import { appendAuditEvents } from './audit.js';
import { selectEntriesByIds } from './entry-reads.js';
import {
  stampOriginProject,
  upsertEntryRow,
  syncFtsRow,
  deleteFtsRow,
  replaceFtsRows,
  stampOriginProjectIn,
  updateMemoryRows,
} from './entry-row.js';
import { mirrorBestEffort, writeMarkdownMirror, purgeMirrorBestEffortIn, removeEntryMirrorsIn } from './mirrors.js';
import { deferDueMirrors, markMirrorsDue } from './due-mirrors.js';
import type { Handles, StoreFiles } from './open.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import type { RenameSourceOptions } from '../port/agent-import.js';
import type { StrengthenOptions } from '../port/recall-writes.js';
import { archiveRawMemory, type ArchiveOptions } from './raw-archive.js';
import { readerReaches, targetReader } from '../../base/scope/recall-scope.js';
import { recordTraceOutcome } from './recall-trace.js';
import type { EntryTarget, EntryWrite, EntryWrites, OutcomeWrite, RawArchive, SupersedeWrite } from '../port.js';
import type { PinWrite } from '../port/entry-writes.js';
import type { AppendAuditOpts } from '../port/types.js';
import { deleteEntryCore } from './delete-and-batch.js';
import { updateStatsUnlessBusy } from './index-and-stats.js';
import { openStore } from './handles.js';
import { bound } from './bound.js';
import { selectMemoryReach } from './tenant-lookup.js';
import { cachedStatement } from '../../db/statement-cache.js';

export interface WriteEntryOptions {
  actor?: string;
  /** Runs after the row commits and before the mirrors, on an idle connection; keep it best-effort. */
  afterCommit?: () => void;
}

/** Store-side only, never exported from a package entry: `afterWrite` hands the write's own db handle to the hook. */
interface WriteEntryInternalOptions extends WriteEntryOptions {
  /** Runs in the same SAVEPOINT as the INSERT, so a throw rolls the row back. */
  afterWrite?: (db: DatabaseSyncLike, memoryId: string) => void;
}

/** Writes a promoted copy on the caller's open store; with `auditAs` the `promote` audit row joins the INSERT's
 * SAVEPOINT, so both or neither. */
export function writePromotedEntry(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entry: MemoryEntry,
  opts: { readonly actor?: string; readonly sourceId: string; readonly auditAs?: { tenantId: string; actor: string } },
): void {
  const { auditAs, sourceId } = opts;
  const afterWrite =
    auditAs &&
    ((own: DatabaseSyncLike, globalId: string) => {
      appendAuditEvents(own, [
        {
          tenantId: auditAs.tenantId,
          actor: auditAs.actor,
          op: 'promote',
          targetId: globalId,
          metadata: { sourceId },
        },
      ]);
    });
  writeEntry(db, files, entry, { actor: opts.actor, afterWrite });
}

/** writeEntry for each of `entries` in one transaction, so all land or none; each keeps its audit row, and mirrors
 * follow the commit. Returns how many were written; an empty list opens no store. */
export function writeEntriesTogether(db: DatabaseSyncLike, files: StoreFiles, entries: readonly MemoryEntry[]): number {
  const stamped = entries.map((entry) => stampOriginProject(files.hippoRoot, entry));
  try {
    withWriteScope(db, 'write_entries_together', () => {
      for (const entry of stamped) writeEntryDbOnly(db, entry);
    });
    for (const entry of stamped) writeEntryMirrors(files.hippoRoot, entry);
  } catch (error) {
    // The scope has unwound, so the refusal row outlives the rollback, as writeEntry's does.
    if (error instanceof RejectedValueError) auditRejectionRefusal(db, error, CLI_ACTOR);
    throw error;
  }
  return stamped.length;
}

/** Runs `fill` in one transaction; each `put` writes one entry and returns false when the store rejects its value,
 * leaving that row's refusal audit and the rest of the batch. Mirrors follow the commit. Returns how many were written.
 */
export function writeEntriesSkippingRejected(
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
        // Skipped like a tombstoned value, so one foreign id cannot abort a sync or share batch; the audit ops are a
        // published list, so the refusal is logged instead of audited.
        if (error instanceof CrossTenantIdError) {
          log.warn(`${error.message}; row skipped`, errorFields(error));
          return false;
        }
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
export function addTagToEntries(
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
  if (tagged.length > 0) writeEntriesTogether(db, files, tagged);
}

/** writeEntry on the caller's open store, so a loop of writes opens the store once; each row still commits alone.
 * `opts.afterWrite` shares the INSERT's SAVEPOINT. */
export function writeEntry(
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
    // writeEntryDbOnly's write scope has already unwound here, so the refusal audit lands post-rollback in a fresh
    // implicit transaction; then rethrow so the caller sees it.
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
  // Inside a caller's transaction (e.g. supersede's BEGIN IMMEDIATE) the scope is a SAVEPOINT, so a throw here rolls
  // back only this write and leaves the outer open.
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
  const tenantId = entry.tenantId;
  audit(db, 'remember', { targetId: entry.id, metadata: rememberAuditMetadata(entry), actor, tenantId });
  // A child write marks its summary parent dirty for the sleep-cycle rebuild; most writes have no parent, so the hot
  // path pays one null check.
  if (entry.dagParentId) {
    markSummaryDirtyInTx(db, entry.dagParentId, entry.tenantId, actor);
  }
}

/** What a row write's `remember` audit row records. */
function rememberAuditMetadata(entry: MemoryEntry) {
  return { kind: entry.kind ?? 'distilled', scope: entry.scope ?? null };
}

/** Markdown mirror path, invoked AFTER commit (a rolled-back tx must leave no orphan markdown). */
export function writeEntryMirrors(hippoRoot: string, entry: MemoryEntry): void {
  mirrorBestEffort(`${entry.id}.md`, () => writeMarkdownMirror(hippoRoot, entry));
}

export function writeEntryMirrorsIn(files: StoreFiles, entry: MemoryEntry): void {
  writeEntryMirrors(files.hippoRoot, entry);
}

/** strengthenRetrieved on an open handle in its own write scope, a savepoint inside a caller's transaction, so a
 * recall's last writes share one handle. */
export function strengthenRetrievedInOwnTx(
  db: DatabaseSyncLike,
  ids: readonly string[],
  opts: StrengthenOptions,
  rules: LossAversion,
): Set<string> {
  if (ids.length === 0 || opts.recallBoostAblated) return new Set();
  try {
    return withWriteScope(db, 'strengthen_retrieved', () => strengthenRetrievedOn(db, ids, opts, rules));
  } catch (error) {
    warnStrengthenFailed(error);
    return new Set();
  }
}

export function warnStrengthenFailed<E>(error: E): void {
  log.warn(`retrieval stats not saved (${errorMessage(error)})`, errorFields(error));
}

// One statement text for any number of rows. Numbers round-trip through JSON exactly from 1e-80 up; only the cached
// strength of a long-decayed wrong memory falls below, and that one may land a unit in the last place off.
const RETRIEVAL_UPDATE_SQL =
  `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS rc, ` +
  `json_extract(value, '$[2]') AS lr, json_extract(value, '$[3]') AS hl, json_extract(value, '$[4]') AS st ` +
  `FROM json_each(?)) UPDATE memories SET retrieval_count = v.rc, last_retrieved = v.lr, half_life_days = v.hl, ` +
  `strength = v.st FROM v WHERE memories.id = v.id`;

/** strengthenRetrieved on the caller's handle, inside the caller's transaction. Throws; the caller decides. */
export function strengthenRetrievedOn(
  db: DatabaseSyncLike,
  ids: readonly string[],
  opts: StrengthenOptions,
  rules: LossAversion,
): Set<string> {
  const found = new Set<string>();
  if (ids.length === 0 || opts.recallBoostAblated) return found;
  const byId = selectEntriesByIds(db, ids, opts.tenantId);
  const live = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
  const updated = markRetrieved(live, undefined, strengthOptionsOf(rules));
  if (updated.length === 0) return found;
  const rows = updated.map((e) => [e.id, e.retrievalCount, e.lastRetrieved, e.halfLifeDays, e.strength]);
  cachedStatement(db, RETRIEVAL_UPDATE_SQL).run(JSON.stringify(rows));
  for (const e of updated) found.add(e.id);
  return found;
}

/** Rewrites a live row's tags and its full-text row on the caller's transaction, with no audit row. */
export function setEntryTagsInTx(db: DatabaseSyncLike, entry: MemoryEntry): void {
  cachedStatement(
    db,
    `UPDATE memories SET tags_json = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`,
  ).run(JSON.stringify(entry.tags), entry.id, entry.tenantId);
  syncFtsRow(db, entry);
}

/** Removes a row from `memories` and full-text search on the caller's transaction, as sleep's dormant move does, and
 * marks its summary parent dirty. */
export function deleteEntryRowInTx(db: DatabaseSyncLike, entry: MemoryEntry, actor: string): void {
  cachedStatement(db, 'DELETE FROM memories WHERE id = ? AND tenant_id = ?').run(entry.id, entry.tenantId);
  deleteFtsRow(db, entry.id);
  if (entry.dagParentId) markSummaryDirtyInTx(db, entry.dagParentId, entry.tenantId, actor);
}

// The last value given for an id wins, as a row-by-row write left it: UPDATE FROM applies any one of an id's matches.
const lastPerId = (pairs: ReadonlyArray<readonly [string, number | string]>): string =>
  JSON.stringify([...new Map(pairs)]);

const HALF_LIFE_UPDATE_SQL =
  `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS hl FROM json_each(?)) ` +
  `UPDATE memories SET half_life_days = v.hl FROM v WHERE memories.id = v.id`;

/** One half-life per memory id, in one statement on the caller's transaction. */
export function setHalfLives(db: DatabaseSyncLike, rows: readonly { id: string; halfLifeDays: number }[]): void {
  if (rows.length === 0) return;
  cachedStatement(db, HALF_LIFE_UPDATE_SQL).run(lastPerId(rows.map((r) => [r.id, r.halfLifeDays])));
}

/** Moves every row of `from` in a tenant to project `into`. */
export function restampOriginProject(db: DatabaseSyncLike, tenantId: string, from: string, into: string): void {
  cachedStatement(
    db,
    `UPDATE memories SET origin_project = ?, updated_at = datetime('now') WHERE tenant_id = ? AND origin_project = ?`,
  ).run(into, tenantId, from);
}

const ORIGIN_STAMP_SQL =
  `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS origin FROM json_each(?)) ` +
  `UPDATE memories SET origin_project = v.origin, updated_at = datetime('now') FROM v ` +
  `WHERE memories.id = v.id AND memories.tenant_id = ?`;

/** Stamps each id with its project, in one statement. */
export function stampOriginProjects(
  db: DatabaseSyncLike,
  tenantId: string,
  rows: readonly { id: string; origin: string }[],
): void {
  if (rows.length === 0) return;
  cachedStatement(db, ORIGIN_STAMP_SQL).run(lastPerId(rows.map((r) => [r.id, r.origin])), tenantId);
}

/** Renames a live row's source from `from` to `to`; the count is 0 when another writer moved or superseded it first. */
export function renameEntrySource(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  from: string,
  to: string,
): number {
  const moved = cachedStatement(
    db,
    `UPDATE memories SET source = ? WHERE id = ? AND tenant_id = ? AND source = ? AND superseded_by IS NULL`,
  ).run(to, id, tenantId, from);
  return Number(moved.changes ?? 0);
}

/** Renames a row's source and, when `origin` is not null, its project; the count is 0 when the row is gone or moved. */
export function renameEntrySourceAndOrigin(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  options: RenameSourceOptions,
): number {
  const { from, to, origin } = options;
  const done = cachedStatement(
    db,
    `UPDATE memories SET source = ?, origin_project = COALESCE(?, origin_project) WHERE id = ? AND tenant_id = ? ` +
      `AND source = ?`,
  ).run(to, origin, id, tenantId, from);
  return Number(done.changes ?? 0);
}

/** Marks `id` superseded by `newId`; false when another writer superseded it first. */
export function supersedeEntry(db: DatabaseSyncLike, tenantId: string, id: string, newId: string): boolean {
  const result = cachedStatement(
    db,
    `UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL`,
  ).run(newId, id, tenantId);
  return Number(result.changes ?? 0) !== 0;
}

/** Each call on its own handle; mirrors and the forgotten counter follow the commit, so a rolled-back write leaves
 * neither. */
export function sqliteEntryWrites({ on, files }: Handles): EntryWrites {
  return {
    ...bound<Pick<EntryWrites, 'writeEntry' | 'applyOutcome' | 'setPinned' | 'forget'>>(
      on,
      {
        writeEntry: (db, write) => writeEntryRow(db, files, write),
        applyOutcome: (db, ...args) => applyOutcome(db, files, ...args),
        setPinned: (db, pin) => {
          const entry = commitPinned(db, pin);
          writeEntryMirrorsIn(files, entry);
          return entry;
        },
        forget: (db, removal) => {
          withWriteScope(db, 'forget_in_reach', () => {
            assertInReach(db, removal, removal.id);
            const { id, tenantId, actor } = removal;
            if (!deleteEntryCore(db, id, tenantId, { actor })) throw notFound(id);
          });
          purgeMirrorBestEffortIn(files, removal.id, false, 'deleteEntry');
          updateStatsUnlessBusy(db, files, { forgotten: 1 }, `removed ${removal.id}`);
        },
      },
      openStore,
    ),
    ...bound<Pick<EntryWrites, 'archiveRaw' | 'supersede'>>(on, {
      archiveRaw: (db, ...args) => archiveRaw(db, files, ...args),
      supersede: (db, write) => {
        const successor = stampOriginProjectIn(files, write.successor);
        commitSupersede(db, { ...write, successor });
        writeEntryMirrorsIn(files, successor);
      },
    }),
  };
}

/** A store-side hook writes on the row's handle inside its write scope, so its throw undoes the row. */
export function writeEntryRow(
  db: DatabaseSyncLike,
  files: StoreFiles,
  { entry, actor }: EntryWrite,
  afterWrite?: WriteEntryInternalOptions['afterWrite'],
): void {
  const stamped = stampOriginProjectIn(files, entry);
  writeInOwnTenant(db, stamped, actor, afterWrite);
  writeEntryMirrorsIn(files, stamped);
}

/** A trace link follows the commit on the same handle and names only the ids applied, so a rolled-back outcome leaves
 * none. */
export function applyOutcome(
  db: DatabaseSyncLike,
  files: StoreFiles,
  outcome: OutcomeWrite,
  traceId?: number,
): string[] {
  const memoryIds = applyOutcomeOn(db, outcome, files).map((entry) => entry.id);
  if (traceId !== undefined && memoryIds.length > 0) {
    recordTraceOutcome(db, {
      traceId,
      tenantId: outcome.tenantId,
      outcome: outcome.good ? 'positive' : 'negative',
      memoryIds,
    });
  }
  if (memoryIds.length > 0) deferDueMirrors(files.hippoRoot);
  return memoryIds;
}

/** Reach is checked inside the archive's write scope. A store-side hook writes on the same handle inside that scope, so
 * its throw undoes the archive. */
export function archiveRaw(
  db: DatabaseSyncLike,
  files: StoreFiles,
  archive: RawArchive,
  afterArchive?: ArchiveOptions['afterArchive'],
): string {
  const at = withWriteScope(db, 'archive_raw_in_reach', () => {
    assertInReach(db, archive, archive.id);
    return archiveRawMemory(db, archive.id, { reason: archive.reason, who: archive.actor, afterArchive });
  });
  cleanArchivedMirrors(db, files, archive.id);
  updateStatsUnlessBusy(db, files, { forgotten: 1 }, `removed ${archive.id}`);
  return at;
}

function notFound(id: string): NotFoundError {
  return new NotFoundError(`memory not found: ${id}`);
}

/** Another tenant's row, or one the caller could not read, answers as missing, so a caller learns nothing about it. */
function assertInReach(db: DatabaseSyncLike, target: EntryTarget, id: string): void {
  const reach = selectMemoryReach(db, id);
  if (reach?.tenantId !== target.tenantId || !readerReaches(targetReader(target), reach.scope)) throw notFound(id);
}

/** The refusal row lands after `write` has rolled back, in a fresh implicit transaction the aborted one cannot undo. */
export function auditingRefusal<T>(db: DatabaseSyncLike, actor: string, write: () => T): T {
  try {
    return write();
  } catch (err) {
    if (err instanceof RejectedValueError) auditRejectionRefusal(db, err, actor);
    throw err;
  }
}

/** writeEntryRow on the caller's handle, so a sibling group can read on it after the scope has unwound. */
export function writeInOwnTenant(
  db: DatabaseSyncLike,
  entry: MemoryEntry,
  actor: string,
  afterWrite?: WriteEntryInternalOptions['afterWrite'],
): void {
  auditingRefusal(db, actor, () =>
    withWriteScope(db, 'write_entry_in_tenant', () => {
      writeEntryDbOnly(db, entry, { actor, afterWrite });
    }),
  );
}

/** The read, row rewrites, audit rows and mirror marks share one BEGIN IMMEDIATE transaction, hippo.db's form of the
 * port's row lock, each a set statement whatever the id count. Returns one entry per applied id with repeats, as
 * callers count them. An outcome never changes content, so the rejected-value guard has nothing to check. */
function applyOutcomeOn(db: DatabaseSyncLike, outcome: OutcomeWrite, rules: LossAversion): readonly MemoryEntry[] {
  return withWriteScope(db, 'apply_outcome', () => {
    const read = selectEntriesByIds(db, outcome.ids, outcome.tenantId);
    const latest = new Map<string, MemoryEntry>();
    const applied: MemoryEntry[] = [];
    for (const id of outcome.ids) {
      const entry = latest.get(id) ?? read.get(id);
      if (!entry || !readerReaches(targetReader(outcome), entry.scope)) continue;
      const updated = entryAfterOutcome(entry, outcome.good, rules);
      latest.set(id, updated);
      applied.push(updated);
    }
    const rows = [...latest.values()];
    updateMemoryRows(db, rows);
    // A good outcome drops the churn-stale tag; only those rows' indexed text changes.
    const retagged = rows.filter((row) => row.tags.join(' ') !== read.get(row.id)?.tags.join(' '));
    if (retagged.length > 0) {
      replaceFtsRows(
        db,
        retagged,
        retagged.map((row) => row.id),
      );
    }
    const parents = [...new Set(rows.flatMap((row) => (row.dagParentId ? [row.dagParentId] : [])))];
    const flipped = markSummariesDirtyInTx(db, parents, outcome.tenantId);
    appendAuditEvents(db, outcomeAuditRows(applied, flipped, outcome));
    markMirrorsDue(
      db,
      rows.map((row) => row.id),
    );
    return applied;
  });
}

/** Per applied id, the rows its own write used to add in turn: remember, the parent's first dirty mark, outcome. */
function outcomeAuditRows(
  applied: readonly MemoryEntry[],
  flipped: ReadonlyMap<string, number>,
  outcome: OutcomeWrite,
): AppendAuditOpts[] {
  const { actor, tenantId, good } = outcome;
  const marked = new Set<string>();
  return applied.flatMap((entry) => {
    const rows: AppendAuditOpts[] = [
      { tenantId: entry.tenantId, actor, op: 'remember', targetId: entry.id, metadata: rememberAuditMetadata(entry) },
    ];
    const parent = entry.dagParentId;
    const level = parent ? flipped.get(parent) : undefined;
    if (parent && level !== undefined && !marked.has(parent)) {
      marked.add(parent);
      rows.push(summaryDirtyAudit(parent, entry.tenantId, actor, level));
    }
    rows.push({ tenantId, actor, op: 'outcome', targetId: entry.id, metadata: { good } });
    return rows;
  });
}

function commitPinned(db: DatabaseSyncLike, pin: PinWrite): MemoryEntry {
  const { tenantId, actor, id, pinned } = pin;
  return auditingRefusal(db, actor, () =>
    withWriteScope(db, 'set_pinned', () => {
      assertInReach(db, pin, id);
      const entry = selectEntriesByIds(db, [id], tenantId).get(id);
      if (!entry) throw notFound(id);
      const updated = { ...entry, pinned };
      writeEntryDbOnly(db, updated, { actor });
      appendAuditEvents(db, [{ tenantId, actor, op: 'pin', targetId: id, metadata: { pinned } }]);
      return updated;
    }),
  );
}

/** Reach, the CAS on the old row, the successor's insert and the supersede row in one BEGIN IMMEDIATE transaction. Two
 * racing supersedes: one CAS wins. */
function commitSupersede(db: DatabaseSyncLike, write: SupersedeWrite): void {
  const { tenantId, actor, oldId, successor } = write;
  // The refusal row lands after the scope has rolled back, in a fresh implicit transaction the aborted one cannot undo.
  auditingRefusal(db, actor, () =>
    withWriteScope(db, 'supersede', () => {
      assertInReach(db, write, oldId);
      // No row means another writer got there first.
      const won = cachedStatement(
        db,
        'UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL RETURNING ' +
          'dag_parent_id',
      ).get(successor.id, oldId, tenantId) as { dag_parent_id: string | null } | undefined;
      if (!won) throw new ConflictError(`Memory ${oldId} already superseded by another writer`);
      // After the CAS, so a lost race marks no parent for rebuild.
      if (won.dag_parent_id) markSummaryDirtyInTx(db, won.dag_parent_id, tenantId, actor);
      writeEntryDbOnly(db, successor, { actor });
      appendAuditEvents(db, [{ tenantId, actor, op: 'supersede', targetId: oldId, metadata: { newId: successor.id } }]);
    }),
  );
}

/** A mirror left on disk would bring the archived row back on the next import; on failure the reaper retries, as
 * mirror_cleaned_at stays NULL. */
function cleanArchivedMirrors(db: DatabaseSyncLike, files: StoreFiles, id: string): void {
  try {
    removeEntryMirrorsIn(files, id);
  } catch (mirrorErr) {
    log.error(
      `archiveRaw: mirror cleanup failed for ${id} (will retry via reaper on next openHippoDb): ` +
        `${errorMessage(mirrorErr)}`,
      errorFields(mirrorErr),
    );
    return;
  }
  try {
    cachedStatement(db, `UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(
      new Date().toISOString(),
      id,
    );
  } catch (err) {
    if (!isSqliteBusy(err)) throw err;
    log.warnThenDebug(
      'archive-mirror-stamp-busy',
      `archived ${id}; the store was busy, so the mirror reaper will re-check it on the next open`,
      errorFields(err),
    );
  }
}
