// hippo.db's half of the EntryWrites store group: the queries remember, outcome, supersede, archive and forget run today.
import { ConflictError, NotFoundError } from '../../api-errors.js';
import { appendAuditEvent } from '../audit.js';
import { isSqliteBusy, withWriteScope, type DatabaseSyncLike } from '../../db.js';
import { errorMessage, log } from '../../log.js';
import { entryAfterOutcome, type MemoryEntry } from '../../memory.js';
import { archiveRawMemory, type ArchiveOpts } from '../raw-archive.js';
import { ownScopeTouches } from '../../recall-scope.js';
import { recordTraceOutcome } from '../recall-trace.js';
import { RejectedValueError } from '../rejection.js';
import type { EntryTarget, EntryWrite, EntryWrites, OutcomeWrite, RawArchive, SupersedeWrite, Sync } from '../port.js';
import { markSummaryDirtyInTx } from '../summary-dirty.js';
import { auditRejectionRefusal } from '../audit-event.js';
import { deleteEntryCore } from '../delete-and-batch.js';
import { selectEntriesByIds } from '../entry-reads.js';
import { stampOriginProject } from '../entry-row.js';
import { writeEntryDbOnly, writeEntryMirrors, type WriteEntryOptions } from '../entry-writes.js';
import { updateStatsUnlessBusy } from '../index-and-stats.js';
import { purgeMirrorBestEffort, removeEntryMirrors } from '../mirrors.js';
import { onHandle, openStore } from '../open.js';
import { selectMemoryReach } from '../tenant-lookup.js';

/** Each call on its own handle; mirrors and the forgotten counter follow the commit, so a rolled-back write leaves neither. */
export function sqliteEntryWrites(hippoRoot: string): Sync<EntryWrites> {
  return {
    writeEntry(write) {
      writeEntryAt(hippoRoot, write);
    },
    applyOutcome(outcome) {
      return applyOutcomeAt(hippoRoot, outcome);
    },
    supersede(write) {
      const successor = stampOriginProject(hippoRoot, write.successor);
      onHandle(hippoRoot, (db) => commitSupersede(db, { ...write, successor }));
      writeEntryMirrors(hippoRoot, successor);
    },
    archiveRaw(archive) {
      return archiveRawAt(hippoRoot, archive);
    },
    forget(removal) {
      onHandle(hippoRoot, (db) => withWriteScope(db, 'forget_in_reach', () => {
        assertInReach(db, removal, removal.id);
        if (!deleteEntryCore(db, removal.id, { actor: removal.actor })) throw notFound(removal.id);
      }), openStore);
      purgeMirrorBestEffort(hippoRoot, removal.id, false, 'deleteEntry');
      updateStatsUnlessBusy(hippoRoot, { forgotten: 1 }, `removed ${removal.id}`);
    },
  };
}

/** A connector's hook writes on the row's handle inside its write scope, so its throw undoes the row. */
export function writeEntryAt(hippoRoot: string, { entry, actor }: EntryWrite, afterWrite?: WriteEntryOptions['afterWrite']): void {
  const stamped = stampOriginProject(hippoRoot, entry);
  onHandle(hippoRoot, (db) => writeInOwnTenant(db, stamped, actor, afterWrite), openStore);
  writeEntryMirrors(hippoRoot, stamped);
}

/** A trace link follows the commit on the same handle and names only the ids applied, so a rolled-back outcome leaves none. */
export function applyOutcomeAt(hippoRoot: string, outcome: OutcomeWrite, traceId?: number): string[] {
  const applied = onHandle(hippoRoot, (db) => {
    const rows = applyOutcomeOn(db, outcome);
    const memoryIds = rows.map((entry) => entry.id);
    if (traceId !== undefined && rows.length > 0) {
      recordTraceOutcome(db, { traceId, tenantId: outcome.tenantId, outcome: outcome.good ? 'positive' : 'negative', memoryIds });
    }
    return rows;
  }, openStore);
  for (const entry of applied) writeEntryMirrors(hippoRoot, entry);
  return applied.map((entry) => entry.id);
}

/** Reach is checked inside the archive's write scope. A connector's hook writes on the same handle inside that scope, so its throw undoes the archive. */
export function archiveRawAt(hippoRoot: string, archive: RawArchive, afterArchive?: ArchiveOpts['afterArchive']): string {
  const archivedAt = onHandle(hippoRoot, (db) => {
    const at = withWriteScope(db, 'archive_raw_in_reach', () => {
      assertInReach(db, archive, archive.id);
      return archiveRawMemory(db, archive.id, { reason: archive.reason, who: archive.actor, afterArchive });
    });
    cleanArchivedMirrors(db, hippoRoot, archive.id);
    return at;
  });
  updateStatsUnlessBusy(hippoRoot, { forgotten: 1 }, `removed ${archive.id}`);
  return archivedAt;
}

function notFound(id: string): NotFoundError {
  return new NotFoundError(`memory not found: ${id}`);
}

/** Another tenant's row, or another person's personal row, answers as missing, so a caller learns nothing about it. */
function assertInReach(db: DatabaseSyncLike, target: EntryTarget, id: string): void {
  const reach = selectMemoryReach(db, id);
  if (reach?.tenantId !== target.tenantId || !ownScopeTouches(target.ownScope, reach.scope)) throw notFound(id);
}

/** hippo.db's upsert would move the row into the writer's tenant, so a store write refuses an id another tenant holds. */
function assertIdInTenant(db: DatabaseSyncLike, entry: MemoryEntry): void {
  const holder = selectMemoryReach(db, entry.id)?.tenantId;
  if (holder !== undefined && holder !== entry.tenantId) throw new ConflictError(`Memory ${entry.id} belongs to another tenant`);
}

/** The refusal row lands after `write` has rolled back, in a fresh implicit transaction the aborted one cannot undo. */
function auditingRefusal<T>(db: DatabaseSyncLike, actor: string, write: () => T): T {
  try {
    return write();
  } catch (err) {
    if (err instanceof RejectedValueError) auditRejectionRefusal(db, err, actor);
    throw err;
  }
}

function writeInOwnTenant(db: DatabaseSyncLike, entry: MemoryEntry, actor: string, afterWrite?: WriteEntryOptions['afterWrite']): void {
  auditingRefusal(db, actor, () => withWriteScope(db, 'write_entry_in_tenant', () => {
    assertIdInTenant(db, entry);
    writeEntryDbOnly(db, entry, { actor, afterWrite });
  }));
}

/** The reads, rewrites and outcome rows share one BEGIN IMMEDIATE transaction, hippo.db's form of the port's row lock; the caller writes the mirrors after. */
function applyOutcomeOn(db: DatabaseSyncLike, outcome: OutcomeWrite): MemoryEntry[] {
  return auditingRefusal(db, outcome.actor, () => withWriteScope(db, 'apply_outcome', () => {
    const live = selectEntriesByIds(db, outcome.ids, outcome.tenantId);
    const applied: MemoryEntry[] = [];
    for (const id of outcome.ids) {
      const entry = live.get(id);
      if (!entry || !ownScopeTouches(outcome.ownScope, entry.scope)) continue;
      const updated = entryAfterOutcome(entry, outcome.good);
      writeEntryDbOnly(db, updated, { actor: outcome.actor });
      live.set(id, updated);
      appendAuditEvent(db, { tenantId: outcome.tenantId, actor: outcome.actor, op: 'outcome', targetId: id, metadata: { good: outcome.good } });
      applied.push(updated);
    }
    return applied;
  }));
}

/** Reach, the CAS on the old row, the successor's insert and the supersede row in one BEGIN IMMEDIATE transaction. Two racing supersedes: one CAS wins. */
function commitSupersede(db: DatabaseSyncLike, write: SupersedeWrite): void {
  const { tenantId, actor, oldId, successor } = write;
  db.exec('BEGIN IMMEDIATE');
  try {
    assertInReach(db, write, oldId);
    // SAFETY: RETURNING names one column, dag_parent_id; no row means another writer got there first.
    const won = db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL RETURNING dag_parent_id')
      .get(successor.id, oldId, tenantId) as { dag_parent_id: string | null } | undefined;
    if (!won) throw new ConflictError(`Memory ${oldId} already superseded by another writer`);
    // After the CAS, so a lost race marks no parent for rebuild.
    if (won.dag_parent_id) markSummaryDirtyInTx(db, won.dag_parent_id, tenantId, actor);
    assertIdInTenant(db, successor);
    writeEntryDbOnly(db, successor, { actor });
    appendAuditEvent(db, { tenantId, actor, op: 'supersede', targetId: oldId, metadata: { newId: successor.id } });
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    // The refusal row lands after ROLLBACK, in a fresh implicit transaction the aborted one cannot undo.
    if (err instanceof RejectedValueError) auditRejectionRefusal(db, err, actor);
    throw err;
  }
}

/** A mirror left on disk would bring the archived row back on the next import; on failure the reaper retries, as mirror_cleaned_at stays NULL. */
function cleanArchivedMirrors(db: DatabaseSyncLike, hippoRoot: string, id: string): void {
  try {
    removeEntryMirrors(hippoRoot, id);
  } catch (mirrorErr) {
    log.error(`archiveRaw: mirror cleanup failed for ${id} (will retry via reaper on next openHippoDb): ${errorMessage(mirrorErr)}`);
    return;
  }
  try {
    db.prepare(`UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(new Date().toISOString(), id);
  } catch (err) {
    if (!isSqliteBusy(err)) throw err;
    log.warnThenDebug('archive-mirror-stamp-busy', `archived ${id}; the store was busy, so the mirror reaper will re-check it on the next open`);
  }
}
