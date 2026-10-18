import { SLEEP_DB_WAIT_MS } from '../../db/index.js';
import { recordAuditEventsRowByRowAt } from '../audit.js';
import { reportAuditWriteFailure } from '../../core/audit-report.js';
import { replaceDetectedConflictsAt } from '../conflicts.js';
import {
  commitInChunksAt,
  deleteEntriesOneByOneAt,
  failedUnitOf,
  memoriesBackingObjectsAt,
} from '../delete-and-batch.js';
import { expireDormantBeforeAt } from '../dormant.js';
import {
  loadAllEntryIdsAt,
  loadCurrentDistilledEntriesAt,
  loadEntriesPageAt,
  selectEntriesByIds,
} from '../entry-reads.js';
import { ftsDriftAt } from '../entry-row.js';
import { writeEntriesTogetherAt, writeEntryAt } from '../entry-writes.js';
import { loadPendingExtractionTenantsAt, markPendingProcessedUpToAt } from '../graph-queue.js';
import { moveHalfLivesAt, recordedHalfLifeBaseAt } from '../half-life.js';
import { appendConsolidationRunAt, incrementSleepCountAt, loadSessionDecayContextAt } from '../index-and-stats.js';
import type { Consolidation } from '../port/consolidation.js';
import { findPromotableSessionsAt, listSessionEventsAt, traceExistsForSessionAt } from '../sessions.js';
import {
  applyRebuildResultAt,
  childrenKey,
  clearSummaryDirtyAfterBuildAt,
  loadAllDirtySummariesAt,
  loadAllL2SummariesAt,
  loadChildrenOfSummariesAt,
  loadChildrenOfSummaryAt,
} from '../summaries.js';
import { lazyTombstoneChecks } from '../tombstone-checks.js';
import { saveStoredParticlesAt, storedParticleIdsAt, storedParticlesByIdsAt } from '../vector-index.js';
import { errorMessage } from '../../util/log.js';
import { type Handles, type OnHandle, waitingOpener } from '../open.js';
import { openStore } from './handles.js';

/** Sleep's store work on its hippo.db, each call on its own short-lived handle. */
export function sqliteConsolidation({ on, onAsync, open }: Handles): Consolidation {
  // The wait is sleep's own, not a server request's 250 ms.
  const sleepOpener = waitingOpener(SLEEP_DB_WAIT_MS);
  const sleepStoreOpener = waitingOpener(SLEEP_DB_WAIT_MS, openStore);
  return {
    entryIds: () => on((db) => loadAllEntryIdsAt(db), openStore),
    entriesByIds: (ids) => (ids.length === 0 ? new Map() : on((db) => selectEntriesByIds(db, ids), openStore)),
    objectBackedIds: () => on((db) => memoriesBackingObjectsAt(db)),
    ftsDrift: (repair) => on((db) => ftsDriftAt(db, repair)),
    sessionDecayContext: () => on((db) => loadSessionDecayContextAt(db), openStore),
    tombstoneChecks: (dryRun) => lazyTombstoneChecks(open, dryRun),
    halfLifeBase: () => on((db) => recordedHalfLifeBaseAt(db)),
    moveHalfLives: (to, opts, plan) => on((db) => moveHalfLivesAt(db, to, opts, plan), openStore),
    promotableSessions: (tenantId, sinceMs) => on((db) => findPromotableSessionsAt(db, tenantId, sinceMs), openStore),
    traceExists: (tenantId, sessionId) => on((db) => traceExistsForSessionAt(db, tenantId, sessionId), openStore),
    sessionEvents: (tenantId, opts) => on((db) => listSessionEventsAt(db, tenantId, opts), openStore),
    particleIds: () => on((db) => storedParticleIdsAt(db)),
    particlesByIds: (ids) => (ids.length === 0 ? [] : on((db) => storedParticlesByIdsAt(db, ids))),
    saveParticles: (particles) => on((db) => saveStoredParticlesAt(db, particles)),
    commitFlush: async (components, opts) =>
      components.length === 0
        ? []
        : onAsync((db, files) => commitInChunksAt(db, files, components, opts), sleepStoreOpener),
    expireDormant: (cutoffIso, opts) => onAsync((db) => expireDormantBeforeAt(db, cutoffIso, opts), sleepOpener),
    replaceConflicts: (detected, detectedAt) =>
      on((db, files) => replaceDetectedConflictsAt(db, files, detected, detectedAt), openStore),
    recordRun: (run) => on((db, files) => appendConsolidationRunAt(db, files, run), openStore),
    countSleep: () => on((db) => incrementSleepCountAt(db), openStore),
    auditEachRow(events) {
      const failed = on((db) => recordAuditEventsRowByRowAt(db, events));
      for (const { event, error } of failed) reportAuditWriteFailure(event.op, errorMessage(error), event.targetId);
      return failed.length;
    },
    reportAuditFailure: (op, reason) => reportAuditWriteFailure(op, reason),
    entriesPage: (page) => on((db) => loadEntriesPageAt(db, undefined, page), openStore),
    currentDistilledEntries: () => on((db) => loadCurrentDistilledEntriesAt(db), openStore),
    deleteOneByOne: (targets, opts) =>
      targets.length === 0 ? [] : on((db, files) => deleteEntriesOneByOneAt(db, files, targets, opts), openStore),
    failedUnitOf,
    dirtyGraphTenants: () => on((db) => loadPendingExtractionTenantsAt(db)),
    markGraphDrained: (tenantId, maxId) => on((db) => markPendingProcessedUpToAt(db, tenantId, maxId)),
    writeEntry: (entry) => on((db, files) => writeEntryAt(db, files, entry), openStore),
    writeTogether: (entries) =>
      entries.length === 0 ? 0 : on((db, files) => writeEntriesTogetherAt(db, files, entries), openStore),
    ...summaryOps(on),
  };
}

type SummaryOps = Pick<
  Consolidation,
  | 'dirtySummaries'
  | 'childrenOfSummary'
  | 'childrenOfSummaries'
  | 'applyRebuild'
  | 'clearSummaryDirty'
  | 'unprofiledTopicSummaries'
>;

function summaryOps(on: OnHandle): SummaryOps {
  return {
    dirtySummaries: (limit) => on((db) => loadAllDirtySummariesAt(db, limit), openStore),
    childrenOfSummary: (summaryId, tenantId) => on((db) => loadChildrenOfSummaryAt(db, summaryId, tenantId), openStore),
    childrenOfSummaries(summaries) {
      const byParent = on((db) => loadChildrenOfSummariesAt(db, summaries), openStore);
      return (summary) => byParent.get(childrenKey(summary.tenant_id, summary.id)) ?? [];
    },
    applyRebuild: (summary, patch) => on((db) => applyRebuildResultAt(db, summary, patch), openStore),
    clearSummaryDirty: (summaryId, tenantId, actor, source) =>
      on((db) => clearSummaryDirtyAfterBuildAt(db, summaryId, tenantId, actor, source), openStore),
    unprofiledTopicSummaries: () => on((db) => loadAllL2SummariesAt(db), openStore),
  };
}
