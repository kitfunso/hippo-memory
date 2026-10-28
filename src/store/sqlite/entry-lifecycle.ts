// hippo.db's EntryWrites group: remember, outcome, pin, supersede, archive and forget.
import { type MemoryEntry } from '../../base/memory/entry.js';
import { entryAfterOutcome } from '../../base/memory/keep-rules.js';
import { type DatabaseSyncLike, withWriteScope, isSqliteBusy } from '../../db/index.js';
import { ConflictError, memoryNotFoundText, NotFoundError } from '../../base/errors/api-errors.js';
import { markSummaryDirtyInTx, markSummariesDirtyInTx } from './summary-dirty.js';
import { summaryDirtyAudit } from '../rules/audit-rows.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import { appendAuditEvents } from './audit.js';
import { readEntriesByIds } from './entry-reads.js';
import { stampOriginProject, replaceFtsRows, updateMemoryRows } from './entry-row.js';
import { purgeMirrorBestEffort, removeEntryMirrors } from './mirrors.js';
import { deferDueMirrors, markMirrorsDue } from './due-mirrors.js';
import type { Handles, StoreFiles, StoreModel } from './open.js';
import { archiveRawMemory, type ArchiveOptions } from './raw-archive.js';
import { assertWriteRight, readerReaches, targetReader } from '../../base/scope/recall-scope.js';
import { recordTraceOutcome } from './recall-trace.js';
import type {
  EntryTarget,
  EntryWrites,
  OutcomeWrite,
  RawArchive,
  SupersedeWrite,
} from '../../base/ports/store.js';
import type { PinWrite } from '../../base/ports/store/entry-writes.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';
import { deleteEntryCore } from './entry-deletes.js';
import { updateStatsUnlessBusy } from './index-and-stats.js';
import { openStore } from './handles.js';
import { bound } from './bound.js';
import { readMemoryReach } from './tenant-lookup.js';
import { cachedStatement } from '../../db/statement-cache.js';
import {
  auditingRefusal,
  rememberAuditMetadata,
  writeEntryDbOnly,
  writeEntryMirrors,
  writeEntryRow,
} from './entry-writes.js';

/** A tenant's row `id` and the row `newId` that supersedes it. */
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
    `UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL`,
  ).run(newId, id, tenantId);
  return Number(result.changes ?? 0) !== 0;
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

/** Another tenant's row, or one out of reach, answers as missing, so a caller learns nothing
 * about it. */
function assertMayChange(db: DatabaseSyncLike, target: EntryTarget, id: string): void {
  const reach = readMemoryReach(db, id);
  const own = reach?.tenantId === target.tenantId ? reach : undefined;
  assertWriteRight(targetReader(target), own, id, memoryNotFoundText(id));
}

/** One BEGIN IMMEDIATE (the port's row lock) of set statements; one entry per applied id, repeats
 * kept. An outcome adds no text, so no guard runs; its rewrite can only redact a legacy row's. */
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
    const redacted = new Set(updateMemoryRows(db, rows));
    // A good outcome drops the churn-stale tag, and a legacy row's text may redact; only those
    // rows' indexed text changes.
    const reindexed = rows.filter(
      (row) => redacted.has(row.id) || row.tags.join(' ') !== read.get(row.id)?.tags.join(' '),
    );
    if (reindexed.length > 0) {
      replaceFtsRows(
        db,
        reindexed,
        reindexed.map((row) => row.id),
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

/** Per applied id, the rows its own write used to add in turn: remember, the parent's first
 * dirty mark, outcome. */
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
 * IMMEDIATE transaction. Two racing supersedes: one CAS wins. */
function commitSupersede(db: DatabaseSyncLike, write: SupersedeWrite): void {
  const { tenantId, actor, oldId, successor } = write;
  // The refusal row lands after the scope has rolled back, in a fresh implicit transaction the
  // aborted one cannot undo.
  auditingRefusal(db, actor, () =>
    withWriteScope(db, 'supersede', () => {
      assertMayChange(db, write, oldId);
      // No row means another writer got there first.
      const won = cachedStatement(
        db,
        'UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL RETURNING ' +
          'dag_parent_id',
      ).get(successor.id, oldId, tenantId) as { dag_parent_id: string | null } | undefined;
      if (!won) throw new ConflictError(`Memory ${oldId} already superseded by another writer`);
      // After the CAS, so a lost race marks no parent for rebuild.
      if (won.dag_parent_id) {
        markSummaryDirtyInTx(db, { summaryId: won.dag_parent_id, tenantId, actor });
      }
      writeEntryDbOnly(db, successor, { actor });
      appendAuditEvents(db, [
        { tenantId, actor, op: 'supersede', targetId: oldId, metadata: { newId: successor.id } },
      ]);
    }),
  );
}

/** A mirror left on disk would bring the archived row back on the next import; on failure the
 * reaper retries, as mirror_cleaned_at stays NULL. */
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
  try {
    cachedStatement(db, `UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(
      files.clock().toISOString(),
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
