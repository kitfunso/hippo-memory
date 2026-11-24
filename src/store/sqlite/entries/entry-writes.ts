import { deleteMemoryOnlyGraphRows } from '../graph/graph-writes.js';
import { type MemoryEntry, markRetrieved } from '../../../base/memory/entry.js';
import { entryAfterOutcome } from '../../../base/memory/keep-rules.js';
import {
  closeHippoDb,
  type DatabaseSyncLike,
  type DbGrant,
  withWriteScope,
} from '../../../db/index.js';
import { rethrowIfStoreBlocked } from '../../../base/util/store-blocked.js';
import {
  RejectedValueError,
  ConflictError,
  CrossTenantIdError,
  memoryNotFoundText,
  NotFoundError,
} from '../../../base/errors/api-errors.js';
import { markSummaryDirtyInTx, markSummariesDirtyInTx } from './summary-dirty.js';
import { summaryDirtyAudit } from '../../rules/audit-rows.js';
import { errorMessage, log, errorFields } from '../../../base/util/log.js';
import { auditRejectionRefusal, audit } from '../audit/audit-event.js';
import { appendAuditEvents } from '../audit/audit.js';
import { readEntriesByIds } from './entry-reads.js';
import {
  stampOriginProject,
  upsertEntryRow,
  syncFtsRow,
  deleteFtsRow,
  replaceFtsRows,
  updateMemoryRows,
} from './entry-row.js';
import {
  mirrorBestEffort,
  writeMarkdownMirror,
  purgeMirrorBestEffort,
  removeEntryMirrors,
} from '../folder-files/mirrors.js';
import { deferDueMirrors, markMirrorsDue } from '../folder-files/due-mirrors.js';
import type { Handles, StoreFiles, StoreModel } from '../runtime/open.js';
import { bindHandleClock } from '../runtime/handle-clock.js';
import { CLI_ACTOR } from '../../../base/scope/actor.js';
import type { RenameSourceOptions } from '../../../base/ports/store/agent-import.js';
import type { StrengthenOptions } from '../../../base/ports/store/recall-writes.js';
import { archiveRawMemory, markMirrorCleaned, type ArchiveOptions } from './raw-archive.js';
import { assertWriteRight, readerReaches, targetReader } from '../../../base/scope/recall-scope.js';
import { recordTraceOutcome } from '../recall/recall-trace.js';
import type {
  EntryTarget,
  EntryWrite,
  EntryWrites,
  OutcomeWrite,
  RawArchive,
  SupersedeWrite,
} from '../../../base/ports/store.js';
import type { PinWrite } from '../../../base/ports/store/entry-writes.js';
import type { AppendAuditOptions } from '../../../base/ports/store/types.js';
import { deleteEntryCore } from './delete-and-batch.js';
import { updateStatsUnlessBusy } from './index-and-stats.js';
import { openStore } from '../runtime/handles.js';
import { bound } from '../runtime/bound.js';
import { readMemoryReach } from '../runtime/tenant-lookup.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { notSupersededIn } from '../../../db/sql-predicates.js';

export interface WriteEntryOptions {
  actor?: string;
  /** Runs after the row commits and before the mirrors, on an idle connection; keep it
   * best-effort. */
  afterCommit?: () => void;
}

interface WriteEntryInternalOptions extends WriteEntryOptions {
  afterWrite?: (db: DatabaseSyncLike, memoryId: string) => void;
}

/** Writes a promoted copy on the caller's open store; with `auditAs` the `promote` audit row
 * joins the INSERT's SAVEPOINT, so both or neither. */
export function writePromotedEntry(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entry: MemoryEntry,
  opts: {
    readonly actor?: string;
    readonly sourceId: string;
    readonly auditAs?: { tenantId: string; actor: string };
  },
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
  writeEntryOn(db, files, entry, { actor: opts.actor, afterWrite });
}

/** writeEntry for each of `entries` in one transaction, so all land or none; each keeps its
 * audit row, and mirrors follow the commit. Returns how many were written; an empty list opens
 * no store. */
export function writeEntriesTogether(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entries: readonly MemoryEntry[],
): number {
  const stamped = entries.map((entry) => stampOriginProject(files, entry));
  try {
    withWriteScope(db, 'write_entries_together', () => {
      for (const entry of stamped) writeEntryDbOnly(db, entry);
    });
    for (const entry of stamped) writeEntryMirrors(files.hippoRoot, entry);
  } catch (error) {
    if (error instanceof RejectedValueError) auditRejectionRefusal(db, error, CLI_ACTOR);
    throw error;
  }
  return stamped.length;
}

/** Runs `fill` in one transaction; each `put` writes one entry and returns false when the store
 * rejects its value, leaving that row's refusal audit and the rest of the batch. Mirrors follow the
 * commit. Returns how many were written.
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
      const stamped = stampOriginProject(files, entry);
      try {
        writeEntryDbOnly(db, stamped, { actor });
      } catch (error) {
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

/** Adds `tag` to each of a tenant's rows that lacks it, in `ids` order, all in one transaction;
 * an id the tenant does not hold is skipped. */
export function addTagToEntries(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  ids: readonly string[],
  tag: string,
): void {
  const live = readEntriesByIds(db, ids, tenantId);
  const tagged = [...new Set(ids)].flatMap((id) => {
    const entry = live.get(id);
    return !entry || entry.tags.includes(tag) ? [] : [{ ...entry, tags: [...entry.tags, tag] }];
  });
  if (tagged.length > 0) writeEntriesTogether(db, files, tagged);
}

/** writeEntry on the caller's open store, so a loop of writes opens the store once; each row
 * still commits alone. `opts.afterWrite` shares the INSERT's SAVEPOINT. */
export function writeEntryOn(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entry: MemoryEntry,
  opts?: WriteEntryInternalOptions,
): void {
  try {
    const stamped = stampOriginProject(files, entry);
    writeEntryDbOnly(db, stamped, opts);
    opts?.afterCommit?.();
    writeEntryMirrors(files.hippoRoot, stamped);
  } catch (error) {
    if (error instanceof RejectedValueError) {
      auditRejectionRefusal(db, error, opts?.actor ?? CLI_ACTOR);
    }
    throw error;
  }
}

/** DB-only write path: upsert, afterWrite hook and audit row inside one withWriteScope; the
 * caller owns `db` and must call `writeEntryMirrors` after any outer tx commits, so a
 * rolled-back tx never leaves orphan markdown. The audit row commits atomically with the INSERT. */
export function writeEntryDbOnly(
  db: DatabaseSyncLike,
  entry: MemoryEntry,
  opts?: Pick<WriteEntryInternalOptions, 'actor' | 'afterWrite'>,
): void {
  withWriteScope(db, 'write_entry', () => {
    upsertEntryRow(db, entry);
    if (opts?.afterWrite) {
      opts.afterWrite(db, entry.id);
    }
    auditEntryWrite(db, entry, opts?.actor ?? CLI_ACTOR);
  });
}

/** What follows a row's upsert inside its write scope: the remember row, last of the write's
 * audit rows, then the summary parent's dirty mark. */
export function auditEntryWrite(db: DatabaseSyncLike, entry: MemoryEntry, actor: string): void {
  const tenantId = entry.tenantId;
  audit(db, 'remember', {
    targetId: entry.id,
    metadata: rememberAuditMetadata(entry),
    actor,
    tenantId,
  });
  if (entry.dagParentId) {
    markSummaryDirtyInTx(db, { summaryId: entry.dagParentId, tenantId: entry.tenantId, actor });
  }
}

function rememberAuditMetadata(entry: MemoryEntry) {
  return { kind: entry.kind ?? 'distilled', scope: entry.scope ?? null };
}

/** Markdown mirror path, invoked AFTER commit (a rolled-back tx must leave no orphan markdown). */
export function writeEntryMirrors(hippoRoot: string, entry: MemoryEntry): void {
  mirrorBestEffort(`${entry.id}.md`, () => writeMarkdownMirror(hippoRoot, entry));
}

function strengthensNothing(ids: readonly string[], opts: StrengthenOptions): boolean {
  return ids.length === 0 || opts.recallBoostAblated;
}

/** strengthenRetrieved on an open handle in its own write scope, a savepoint inside a caller's
 * transaction, so a recall's last writes share one handle. */
export function strengthenRetrievedInOwnTx(
  db: DatabaseSyncLike,
  ids: readonly string[],
  opts: StrengthenOptions,
  rules: StoreModel,
): Set<string> {
  if (strengthensNothing(ids, opts)) return new Set();
  try {
    return withWriteScope(db, 'strengthen_retrieved', () =>
      strengthenRetrievedOn(db, ids, opts, rules),
    );
  } catch (error) {
    warnStrengthenFailed(error);
    return new Set();
  }
}

function warnStrengthenFailed<E>(error: E): void {
  log.warn(`retrieval stats not saved (${errorMessage(error)})`, errorFields(error));
}

/** Strengthen what a recall returned from the global store, on a handle of its own: only the
 * four retrieval columns of the live row change. Best effort: a failure logs and never fails the
 * read. Returns the ids found there. */
export function strengthenRetrieved(
  hippoRoot: string,
  ids: readonly string[],
  opts: StrengthenOptions,
  rules: StoreModel,
  grant: DbGrant,
): Set<string> {
  if (strengthensNothing(ids, opts)) return new Set();
  let db: DatabaseSyncLike;
  try {
    db = bindHandleClock(grant.open(hippoRoot), rules.clock);
  } catch (error) {
    rethrowIfStoreBlocked(error);
    warnStrengthenFailed(error);
    return new Set();
  }
  try {
    return strengthenRetrievedInOwnTx(db, ids, opts, rules);
  } finally {
    closeHippoDb(db);
  }
}

const RETRIEVAL_UPDATE_SQL =
  `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS rc, ` +
  `json_extract(value, '$[2]') AS lr, json_extract(value, '$[3]') AS hl, json_extract(value, '$[4]') AS st ` +
  `FROM json_each(?)) UPDATE memories SET retrieval_count = v.rc, last_retrieved = v.lr, half_life_days = v.hl, ` +
  `strength = v.st FROM v WHERE memories.id = v.id`;

/** strengthenRetrieved on the caller's handle, inside the caller's transaction. Throws; the
 * caller decides. */
export function strengthenRetrievedOn(
  db: DatabaseSyncLike,
  ids: readonly string[],
  opts: StrengthenOptions,
  rules: StoreModel,
): Set<string> {
  const found = new Set<string>();
  if (strengthensNothing(ids, opts)) return found;
  const byId = readEntriesByIds(db, ids, opts.tenantId);
  const live = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
  const updated = markRetrieved(live, rules.clock(), rules.strength);
  if (updated.length === 0) return found;
  const rows = updated.map((e) => [
    e.id,
    e.retrievalCount,
    e.lastRetrieved,
    e.halfLifeDays,
    e.strength,
  ]);
  cachedStatement(db, RETRIEVAL_UPDATE_SQL).run(JSON.stringify(rows));
  for (const e of updated) found.add(e.id);
  return found;
}

/** Rewrites a live row's tags and its full-text row on the caller's transaction, with no audit
 * row. */
export function setEntryTagsInTx(db: DatabaseSyncLike, entry: MemoryEntry): void {
  cachedStatement(
    db,
    `UPDATE memories SET tags_json = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`,
  ).run(JSON.stringify(entry.tags), entry.id, entry.tenantId);
  syncFtsRow(db, entry);
}

/** Removes a row from `memories` and full-text search on the caller's transaction, as sleep's
 * dormant move does, and marks its summary parent dirty. */
export function deleteEntryRowInTx(db: DatabaseSyncLike, entry: MemoryEntry, actor: string): void {
  deleteMemoryOnlyGraphRows(db, {
    sql: 'SELECT id FROM memories WHERE id = ? AND tenant_id = ?',
    params: [entry.id, entry.tenantId],
  });
  cachedStatement(db, 'DELETE FROM memories WHERE id = ? AND tenant_id = ?').run(
    entry.id,
    entry.tenantId,
  );
  deleteFtsRow(db, entry.id);
  if (entry.dagParentId) {
    markSummaryDirtyInTx(db, { summaryId: entry.dagParentId, tenantId: entry.tenantId, actor });
  }
}

const lastPerId = (pairs: ReadonlyArray<readonly [string, number | string]>): string =>
  JSON.stringify([...new Map(pairs)]);

const HALF_LIFE_UPDATE_SQL =
  `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS hl FROM json_each(?)) ` +
  `UPDATE memories SET half_life_days = v.hl FROM v WHERE memories.id = v.id`;

/** One half-life per memory id, in one statement on the caller's transaction. */
export function setHalfLives(
  db: DatabaseSyncLike,
  rows: readonly { id: string; halfLifeDays: number }[],
): void {
  if (rows.length === 0) return;
  cachedStatement(db, HALF_LIFE_UPDATE_SQL).run(lastPerId(rows.map((r) => [r.id, r.halfLifeDays])));
}

/** A tenant's project `from` and the project `into` that takes its rows. */
export interface OriginMoveOptions {
  readonly tenantId: string;
  readonly from: string;
  readonly into: string;
}

/** Moves every row of `from` in a tenant to project `into`. */
export function restampOriginProject(
  db: DatabaseSyncLike,
  { tenantId, from, into }: OriginMoveOptions,
): void {
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

interface RenameEntrySourceOptions {
  readonly tenantId: string;
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** Renames a live row's source from `from` to `to`; the count is 0 when another writer moved or
 * superseded it first. */
export function renameEntrySource(
  db: DatabaseSyncLike,
  { tenantId, id, from, to }: RenameEntrySourceOptions,
): number {
  const moved = cachedStatement(
    db,
    `UPDATE memories SET source = ? WHERE id = ? AND tenant_id = ? AND source = ? AND ${notSupersededIn()}`,
  ).run(to, id, tenantId, from);
  return Number(moved.changes ?? 0);
}

/** Renames a row's source and, when `origin` is not null, its project; the count is 0 when the
 * row is gone or moved. */
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

interface SupersedeEntryOptions {
  readonly tenantId: string;
  readonly id: string;
  readonly newId: string;
}

/** Marks `id` superseded by `newId`; false when another writer superseded it first. */
export function supersedeEntry(
  db: DatabaseSyncLike,
  { tenantId, id, newId }: SupersedeEntryOptions,
): boolean {
  const result = cachedStatement(
    db,
    `UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND ${notSupersededIn()}`,
  ).run(newId, id, tenantId);
  return Number(result.changes ?? 0) !== 0;
}

/** Marks `id` superseded by `newId` in the caller's transaction, with the supersede audit row and
 * its summary parent's dirty mark; false when the row is gone or another writer got there first. */
export function supersedeInTx(
  db: DatabaseSyncLike,
  { tenantId, id, newId, actor }: SupersedeEntryOptions & { actor: string },
): boolean {
  const won = cachedStatement(
    db,
    `UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND ${notSupersededIn()} ` +
      'RETURNING dag_parent_id',
  ).get(newId, id, tenantId) as { dag_parent_id: string | null } | undefined;
  if (!won) return false;
  if (won.dag_parent_id) {
    markSummaryDirtyInTx(db, { summaryId: won.dag_parent_id, tenantId, actor });
  }
  appendAuditEvents(db, [{ tenantId, actor, op: 'supersede', targetId: id, metadata: { newId } }]);
  return true;
}

/** Each call on its own handle; mirrors and the forgotten counter follow the commit, so a
 * rolled-back write leaves neither. */
export function sqliteEntryWrites({ on, files }: Handles): EntryWrites {
  return {
    ...bound<Pick<EntryWrites, 'writeEntry' | 'applyOutcome' | 'setPinned' | 'forget'>>(
      on,
      {
        writeEntry: (db, write) => writeEntryRow(db, files, write),
        applyOutcome: (db, ...args) => writeOutcome(db, files, ...args),
        setPinned: (db, pin) => {
          const entry = commitPinned(db, pin);
          writeEntryMirrors(files.hippoRoot, entry);
          return entry;
        },
        forget: (db, removal) => {
          withWriteScope(db, 'forget_in_reach', () => {
            assertMayChange(db, removal, removal.id);
            const { id, tenantId, actor } = removal;
            if (!deleteEntryCore(db, id, tenantId, { actor })) throw notFound(id);
          });
          const purge = { id: removal.id, isRaw: false, logPrefix: 'deleteEntry' };
          purgeMirrorBestEffort(files.hippoRoot, purge);
          updateStatsUnlessBusy(db, files, { forgotten: 1 }, `removed ${removal.id}`);
        },
      },
      openStore,
    ),
    ...bound<Pick<EntryWrites, 'archiveRaw' | 'supersede'>>(on, {
      archiveRaw: (db, ...args) => archiveRaw(db, files, ...args),
      supersede: (db, write) => {
        const successor = stampOriginProject(files, write.successor);
        commitSupersede(db, { ...write, successor });
        writeEntryMirrors(files.hippoRoot, successor);
      },
    }),
  };
}

/** A store-side hook writes on the row's handle inside its write scope, so its throw undoes the
 * row. */
export function writeEntryRow(
  db: DatabaseSyncLike,
  files: StoreFiles,
  { entry, actor }: EntryWrite,
  afterWrite?: WriteEntryInternalOptions['afterWrite'],
): void {
  const stamped = stampOriginProject(files, entry);
  writeInOwnTenant(db, stamped, actor, afterWrite);
  writeEntryMirrors(files.hippoRoot, stamped);
}

/** A trace link follows the commit on the same handle and names only the ids applied, so a
 * rolled-back outcome leaves none. */
export function writeOutcome(
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
  if (memoryIds.length > 0) deferDueMirrors(files);
  return memoryIds;
}

/** Write rights are checked inside the archive's write scope. A store-side hook writes on the
 * same handle inside that scope, so its throw undoes the archive. */
export function archiveRaw(
  db: DatabaseSyncLike,
  files: StoreFiles,
  archive: RawArchive,
  afterArchive?: ArchiveOptions['afterArchive'],
): string {
  const at = withWriteScope(db, 'archive_raw_in_reach', () => {
    assertMayChange(db, archive, archive.id);
    return archiveRawMemory(db, archive.id, {
      reason: archive.reason,
      who: archive.actor,
      afterArchive,
    });
  });
  cleanArchivedMirrors(db, files, archive.id);
  updateStatsUnlessBusy(db, files, { forgotten: 1 }, `removed ${archive.id}`);
  return at;
}

function notFound(id: string): NotFoundError {
  return new NotFoundError(memoryNotFoundText(id));
}

function assertMayChange(db: DatabaseSyncLike, target: EntryTarget, id: string): void {
  const reach = readMemoryReach(db, id);
  const own = reach?.tenantId === target.tenantId ? reach : undefined;
  assertWriteRight(targetReader(target), own, id, memoryNotFoundText(id));
}

/** The refusal row lands after `write` has rolled back, in a fresh implicit transaction the
 * aborted one cannot undo. */
export function auditingRefusal<T>(db: DatabaseSyncLike, actor: string, write: () => T): T {
  try {
    return write();
  } catch (err) {
    if (err instanceof RejectedValueError) auditRejectionRefusal(db, err, actor);
    throw err;
  }
}

/** writeEntryRow on the caller's handle, so a sibling group can read on it after the scope has
 * unwound. */
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

function applyOutcomeOn(
  db: DatabaseSyncLike,
  outcome: OutcomeWrite,
  rules: StoreModel,
): readonly MemoryEntry[] {
  return withWriteScope(db, 'apply_outcome', () => {
    const read = readEntriesByIds(db, outcome.ids, outcome.tenantId);
    const latest = new Map<string, MemoryEntry>();
    const applied: MemoryEntry[] = [];
    for (const id of outcome.ids) {
      const entry = latest.get(id) ?? read.get(id);
      if (!entry || !readerReaches(targetReader(outcome), entry.scope)) continue;
      const updated = entryAfterOutcome(entry, outcome.good, rules.clock(), rules.strength);
      latest.set(id, updated);
      applied.push(updated);
    }
    const rows = [...latest.values()];
    updateMemoryRows(db, rows);
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

function outcomeAuditRows(
  applied: readonly MemoryEntry[],
  flipped: ReadonlyMap<string, number>,
  outcome: OutcomeWrite,
): AppendAuditOptions[] {
  const { actor, tenantId, good } = outcome;
  const marked = new Set<string>();
  return applied.flatMap((entry) => {
    const rows: AppendAuditOptions[] = [
      {
        tenantId: entry.tenantId,
        actor,
        op: 'remember',
        targetId: entry.id,
        metadata: rememberAuditMetadata(entry),
      },
    ];
    const parent = entry.dagParentId;
    const level = parent ? flipped.get(parent) : undefined;
    if (parent && level !== undefined && !marked.has(parent)) {
      marked.add(parent);
      rows.push(summaryDirtyAudit({ summaryId: parent, tenantId: entry.tenantId, actor }, level));
    }
    rows.push({ tenantId, actor, op: 'outcome', targetId: entry.id, metadata: { good } });
    return rows;
  });
}

function commitPinned(db: DatabaseSyncLike, pin: PinWrite): MemoryEntry {
  const { tenantId, actor, id, pinned } = pin;
  return auditingRefusal(db, actor, () =>
    withWriteScope(db, 'set_pinned', () => {
      assertMayChange(db, pin, id);
      const entry = readEntriesByIds(db, [id], tenantId).get(id);
      if (!entry) throw notFound(id);
      const updated = { ...entry, pinned };
      writeEntryDbOnly(db, updated, { actor });
      appendAuditEvents(db, [{ tenantId, actor, op: 'pin', targetId: id, metadata: { pinned } }]);
      return updated;
    }),
  );
}

/** Reach, the CAS on the old row, the successor's insert and the supersede row in one BEGIN
 * IMMEDIATE transaction. Two racing supersedes: one CAS wins. `afterWrite` runs on the successor's row inside
 * the same scope, so its throw undoes the supersede. */
export function commitSupersede(
  db: DatabaseSyncLike,
  write: SupersedeWrite,
  afterWrite?: WriteEntryInternalOptions['afterWrite'],
): void {
  const { tenantId, actor, oldId, successor } = write;
  auditingRefusal(db, actor, () =>
    withWriteScope(db, 'supersede', () => {
      assertMayChange(db, write, oldId);
      const won = cachedStatement(
        db,
        `UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND ${notSupersededIn()} ` +
          'RETURNING dag_parent_id',
      ).get(successor.id, oldId, tenantId) as { dag_parent_id: string | null } | undefined;
      if (!won) throw new ConflictError(`Memory ${oldId} already superseded by another writer`);
      if (won.dag_parent_id) {
        markSummaryDirtyInTx(db, { summaryId: won.dag_parent_id, tenantId, actor });
      }
      writeEntryDbOnly(db, successor, { actor, afterWrite });
      appendAuditEvents(db, [
        { tenantId, actor, op: 'supersede', targetId: oldId, metadata: { newId: successor.id } },
      ]);
    }),
  );
}

function cleanArchivedMirrors(db: DatabaseSyncLike, files: StoreFiles, id: string): void {
  try {
    removeEntryMirrors(files.hippoRoot, id);
  } catch (mirrorErr) {
    log.error(
      `archiveRaw: mirror cleanup failed for ${id} (will retry via reaper on next openHippoDb): ` +
        `${errorMessage(mirrorErr)}`,
      errorFields(mirrorErr),
    );
    return;
  }
  markMirrorCleaned(db, id, files.clock().toISOString());
}
