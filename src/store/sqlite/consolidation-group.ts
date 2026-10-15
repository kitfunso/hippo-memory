import { SLEEP_DB_WAIT_MS } from '../../db/index.js';
import { recordAuditEventsRowByRow, reportAuditWriteFailure } from '../audit.js';
import { replaceDetectedConflicts } from '../conflicts.js';
import { commitInChunks, memoriesBackingObjects } from '../delete-and-batch.js';
import { expireDormantBefore } from '../dormant.js';
import { loadAllEntriesWithBase } from '../entry-reads.js';
import { ftsDrift } from '../entry-row.js';
import { moveHalfLives, recordedHalfLifeBase } from '../half-life.js';
import { appendConsolidationRun, incrementSleepCount, loadSessionDecayContext } from '../index-and-stats.js';
import type { Consolidation } from '../port/consolidation.js';
import { findPromotableSessions, listSessionEvents, traceExistsForSession } from '../sessions.js';
import { lazyTombstoneChecks } from '../tombstone-checks.js';
import { loadStoredParticles, saveStoredParticles } from '../vector-index.js';
import { errorMessage } from '../../util/log.js';

/** Sleep's store work on the hippo.db under `hippoRoot`, each call on its own short-lived handle. */
export function sqliteConsolidation(hippoRoot: string): Consolidation {
  return {
    entriesWithBase: () => loadAllEntriesWithBase(hippoRoot),
    objectBackedIds: () => memoriesBackingObjects(hippoRoot),
    ftsDrift: (repair) => ftsDrift(hippoRoot, repair),
    sessionDecayContext: () => loadSessionDecayContext(hippoRoot),
    tombstoneChecks: (dryRun) => lazyTombstoneChecks(hippoRoot, dryRun),
    halfLifeBase: () => recordedHalfLifeBase(hippoRoot),
    moveHalfLives: (to, opts, plan) => moveHalfLives(hippoRoot, to, opts, plan),
    promotableSessions: (tenantId, sinceMs) => findPromotableSessions(hippoRoot, tenantId, sinceMs),
    traceExists: (tenantId, sessionId) => traceExistsForSession(hippoRoot, tenantId, sessionId),
    sessionEvents: (tenantId, opts) => listSessionEvents(hippoRoot, tenantId, opts),
    storedParticles: () => loadStoredParticles(hippoRoot),
    saveParticles: (particles) => saveStoredParticles(hippoRoot, particles),
    // The wait is sleep's own, not a server request's 250 ms.
    commitFlush: (components, opts) => commitInChunks(hippoRoot, components, { ...opts, busyWaitMs: SLEEP_DB_WAIT_MS }),
    expireDormant: (cutoffIso, opts) =>
      expireDormantBefore(hippoRoot, cutoffIso, { ...opts, busyWaitMs: SLEEP_DB_WAIT_MS }),
    replaceConflicts: (detected, detectedAt) => replaceDetectedConflicts(hippoRoot, detected, detectedAt),
    recordRun: (run) => appendConsolidationRun(hippoRoot, run),
    countSleep: () => incrementSleepCount(hippoRoot),
    auditEachRow(events) {
      const failed = recordAuditEventsRowByRow(hippoRoot, events);
      for (const { event, error } of failed) reportAuditWriteFailure(event.op, errorMessage(error), event.targetId);
      return failed.length;
    },
  };
}
