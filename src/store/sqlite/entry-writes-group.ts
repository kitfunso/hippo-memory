// hippo.db's half of the EntryWrites store group: the queries remember, outcome, supersede, archive and forget run
// today.
import { ConflictError, NotFoundError } from '../../core/api-errors.js';
import { appendAuditEvent, appendAuditEventsAt } from '../audit.js';
import { isSqliteBusy, withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { errorFields, errorMessage, log } from '../../util/log.js';
import { entryAfterOutcome, type MemoryEntry } from '../../core/memory.js';
import { archiveRawMemory, type ArchiveOptions } from '../raw-archive.js';
import { ownScopeTouches } from '../../core/recall-scope.js';
import { recordTraceOutcome } from '../recall-trace.js';
import { RejectedValueError } from '../../core/api-errors.js';
import type { EntryTarget, EntryWrite, EntryWrites, OutcomeWrite, RawArchive, SupersedeWrite, Sync } from '../port.js';
import type { PinWrite } from '../port/entry-writes.js';
import type { AppendAuditOpts } from '../port/types.js';
import { markSummariesDirtyInTx, markSummaryDirtyInTx, summaryDirtyAuditRow } from '../summary-dirty.js';
import { auditRejectionRefusal } from '../audit-event.js';
import { deleteEntryCore } from '../delete-and-batch.js';
import { selectEntriesByIds } from '../entry-reads.js';
import {
  rememberAuditMetadata,
  writeEntryDbOnly,
  writeEntryMirrorsIn,
  type WriteEntryInternalOptions,
} from '../entry-writes.js';
import { updateStatsUnlessBusyAt } from '../index-and-stats.js';
import type { OnHandle, StoreFiles } from '../open.js';
import { openStore } from './handles.js';
import { purgeMirrorBestEffortIn, removeEntryMirrorsIn, writeMarkdownMirrors } from '../mirrors.js';
import { replaceFtsRows, stampOriginProjectIn, updateMemoryRows } from '../entry-row.js';
import { selectMemoryReach } from '../tenant-lookup.js';

/** Each call on its own handle; mirrors and the forgotten counter follow the commit, so a rolled-back write leaves
 * neither. */
export function sqliteEntryWrites(on: OnHandle): Sync<EntryWrites> {
  return {
    writeEntry(write) {
      on((db, files) => writeEntryRowAt(db, files, write), openStore);
    },
    applyOutcome(outcome) {
      return on((db, files) => applyOutcomeAt(db, files, outcome), openStore);
    },
    setPinned(pin) {
      return on((db, files) => {
        const entry = commitPinned(db, pin);
        writeEntryMirrorsIn(files, entry);
        return entry;
      }, openStore);
    },
    supersede(write) {
      on((db, files) => {
        const successor = stampOriginProjectIn(files, write.successor);
        commitSupersede(db, { ...write, successor });
        writeEntryMirrorsIn(files, successor);
      });
    },
    archiveRaw(archive) {
      return on((db, files) => archiveRawAt(db, files, archive));
    },
    forget(removal) {
      on((db, files) => {
        withWriteScope(db, 'forget_in_reach', () => {
          assertInReach(db, removal, removal.id);
          if (!deleteEntryCore(db, removal.id, removal.tenantId, { actor: removal.actor })) throw notFound(removal.id);
        });
        purgeMirrorBestEffortIn(files, removal.id, false, 'deleteEntry');
        updateStatsUnlessBusyAt(db, files, { forgotten: 1 }, `removed ${removal.id}`);
      }, openStore);
    },
  };
}

/** A store-side hook writes on the row's handle inside its write scope, so its throw undoes the row. */
export function writeEntryRowAt(
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
export function applyOutcomeAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  outcome: OutcomeWrite,
  traceId?: number,
): string[] {
  const { applied, rows } = applyOutcomeOn(db, outcome);
  const memoryIds = applied.map((entry) => entry.id);
  if (traceId !== undefined && memoryIds.length > 0) {
    recordTraceOutcome(db, {
      traceId,
      tenantId: outcome.tenantId,
      outcome: outcome.good ? 'positive' : 'negative',
      memoryIds,
    });
  }
  writeMarkdownMirrors(files.hippoRoot, rows);
  return memoryIds;
}

/** Reach is checked inside the archive's write scope. A store-side hook writes on the same handle inside that scope, so
 * its throw undoes the archive. */
export function archiveRawAt(
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
  updateStatsUnlessBusyAt(db, files, { forgotten: 1 }, `removed ${archive.id}`);
  return at;
}

function notFound(id: string): NotFoundError {
  return new NotFoundError(`memory not found: ${id}`);
}

/** Another tenant's row, or another person's personal row, answers as missing, so a caller learns nothing about it. */
function assertInReach(db: DatabaseSyncLike, target: EntryTarget, id: string): void {
  const reach = selectMemoryReach(db, id);
  if (reach?.tenantId !== target.tenantId || !ownScopeTouches(target.ownScope, reach.scope)) throw notFound(id);
}

/** hippo.db's upsert would move the row into the writer's tenant, so a store write refuses an id another tenant
 * holds. */
function assertIdInTenant(db: DatabaseSyncLike, entry: MemoryEntry): void {
  const holder = selectMemoryReach(db, entry.id)?.tenantId;
  if (holder !== undefined && holder !== entry.tenant_id) {
    throw new ConflictError(`Memory ${entry.id} belongs to another tenant`);
  }
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

/** writeEntryRowAt on the caller's handle, so a sibling group can read on it after the scope has unwound. */
export function writeInOwnTenant(
  db: DatabaseSyncLike,
  entry: MemoryEntry,
  actor: string,
  afterWrite?: WriteEntryInternalOptions['afterWrite'],
): void {
  auditingRefusal(db, actor, () =>
    withWriteScope(db, 'write_entry_in_tenant', () => {
      assertIdInTenant(db, entry);
      writeEntryDbOnly(db, entry, { actor, afterWrite });
    }),
  );
}

/** What an outcome wrote: one entry per applied id with repeats, as callers count them, and each row's final state. */
interface AppliedOutcome {
  readonly applied: readonly MemoryEntry[];
  readonly rows: readonly MemoryEntry[];
}

/** The read, the row rewrites and the audit rows share one BEGIN IMMEDIATE transaction, hippo.db's form of the port's
 * row lock, each a set statement whatever the id count; the caller writes the mirrors after. An outcome never changes
 * content, so the rejected-value guard has nothing to check. */
function applyOutcomeOn(db: DatabaseSyncLike, outcome: OutcomeWrite): AppliedOutcome {
  return withWriteScope(db, 'apply_outcome', () => {
    const read = selectEntriesByIds(db, outcome.ids, outcome.tenantId);
    const latest = new Map<string, MemoryEntry>();
    const applied: MemoryEntry[] = [];
    for (const id of outcome.ids) {
      const entry = latest.get(id) ?? read.get(id);
      if (!entry || !ownScopeTouches(outcome.ownScope, entry.scope)) continue;
      const updated = entryAfterOutcome(entry, outcome.good);
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
    const parents = [...new Set(rows.flatMap((row) => (row.dag_parent_id ? [row.dag_parent_id] : [])))];
    const flipped = markSummariesDirtyInTx(db, parents, outcome.tenantId);
    appendAuditEventsAt(db, outcomeAuditRows(applied, flipped, outcome));
    return { applied, rows };
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
      { tenantId: entry.tenant_id, actor, op: 'remember', targetId: entry.id, metadata: rememberAuditMetadata(entry) },
    ];
    const parent = entry.dag_parent_id;
    const level = parent ? flipped.get(parent) : undefined;
    if (parent && level !== undefined && !marked.has(parent)) {
      marked.add(parent);
      rows.push(summaryDirtyAuditRow(parent, entry.tenant_id, actor, level));
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
      appendAuditEvent(db, { tenantId, actor, op: 'pin', targetId: id, metadata: { pinned } });
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
      // SAFETY: RETURNING names one column, dag_parent_id; no row means another writer got there first.
      const won = db
        .prepare(
          'UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL RETURNING ' +
            'dag_parent_id',
        )
        .get(successor.id, oldId, tenantId) as { dag_parent_id: string | null } | undefined;
      if (!won) throw new ConflictError(`Memory ${oldId} already superseded by another writer`);
      // After the CAS, so a lost race marks no parent for rebuild.
      if (won.dag_parent_id) markSummaryDirtyInTx(db, won.dag_parent_id, tenantId, actor);
      assertIdInTenant(db, successor);
      writeEntryDbOnly(db, successor, { actor });
      appendAuditEvent(db, { tenantId, actor, op: 'supersede', targetId: oldId, metadata: { newId: successor.id } });
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
    db.prepare(`UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(new Date().toISOString(), id);
  } catch (err) {
    if (!isSqliteBusy(err)) throw err;
    log.warnThenDebug(
      'archive-mirror-stamp-busy',
      `archived ${id}; the store was busy, so the mirror reaper will re-check it on the next open`,
      errorFields(err),
    );
  }
}
