// hippo.db's half of the HookStore group: the queries the hook callers ran on their own handles.
import { recordByRequest, recordProgress, recordSummary, markItemsDone, markSnapshotSaved, selectHeldItems, startCompaction } from '../compaction-record.js';
import { rethrowIfSqliteBlocked, withWriteScope, type DatabaseSyncLike } from '../db.js';
import { loggedRequest, recordFailure, settleFailureOutcome } from '../failure-log.js';
import { errorMessage, log } from '../log.js';
import type { MemoryEntry } from '../memory.js';
import { bookPilotArm, readPilotArm } from '../pilot-arm.js';
import { touchableScopeSql } from '../recall-scope.js';
import { findRejectedValue } from '../rejection.js';
import { boundOrBind } from '../session-owners.js';
import type { CompactionItemsResult, CompactionItemsWrite, HookStore, RejectedValueMark } from '../store-port.js';
import { lastSentState } from '../token-ledger.js';
import { audit } from './audit-event.js';
import { loadTextsHoldingWords } from './candidates.js';
import { loadContentsWithTag } from './entry-reads.js';
import { strengthenRetrievedOn, writeEntryDbOnly, writeEntryMirrors } from './entry-writes.js';
import { loadLatestHandoff, saveSessionHandoff, sessionCompleteContent } from './handoffs.js';
import { updateStats } from './index-and-stats.js';
import { onHandle } from './open.js';
import { closeTaskSnapshotsForSession, loadActiveTaskSnapshot, saveActiveTaskSnapshot } from './sessions.js';

export function sqliteHookStore(hippoRoot: string): HookStore {
  return {
    async bindSession({ tenantId, sessionId, owner }) {
      return onHandle(hippoRoot, (db) => boundOrBind(db, tenantId, sessionId, owner));
    },
    async pilotArm(tenantId, sessionId, book) {
      return onHandle(hippoRoot, (db) => book === null
        ? readPilotArm(db, sessionId, tenantId)
        : bookPilotArm(db, tenantId, sessionId, book, { ownTenantOnly: true }));
    },
    async lastSent(tenantId, sessionId, surface) {
      return onHandle(hippoRoot, (db) => lastSentState(db, tenantId, sessionId, surface));
    },
    async textsHoldingWords({ tenantId, words, project, reach }) {
      const admit = reach.kind === 'team' ? undefined : touchableScopeSql('', reach.ownScope);
      return loadTextsHoldingWords(hippoRoot, tenantId, words, project, admit);
    },
    async contentsWithTag(tenantId, tag, origins) {
      return loadContentsWithTag(hippoRoot, tenantId, tag, origins);
    },
    async endSession({ tenantId, sessionId, key, plan }) {
      const draft = plan({
        activeSnapshot: loadActiveTaskSnapshot(hippoRoot, tenantId, key),
        latestHandoff: loadLatestHandoff(hippoRoot, tenantId, sessionId, {}, key),
        completedWith: sessionCompleteContent(hippoRoot, tenantId, sessionId),
      });
      const handoff = draft === null ? null : saveSessionHandoff(hippoRoot, tenantId, draft, key);
      return { handoff, snapshotsClosed: closeTaskSnapshotsForSession(hippoRoot, tenantId, sessionId, 'session-ended', key) };
    },
    async saveSnapshot(tenantId, snapshot, key) {
      return saveActiveTaskSnapshot(hippoRoot, tenantId, snapshot, key);
    },
    async startCompaction(open) {
      onHandle(hippoRoot, (db) => withWriteScope(db, 'start_compaction', () => {
        const start = { sessionId: open.sessionId, originProject: open.originProject, trigger: open.trigger, cwd: null, transcriptPath: null };
        startCompaction(db, open.tenantId, start, new Date(open.startedAt), open.id);
        if (open.snapshotSaved) markSnapshotSaved(db, open.tenantId, open.id);
      }));
    },
    async compactionByRequest(tenantId, requestId) {
      return onHandle(hippoRoot, (db) => recordByRequest(db, tenantId, requestId));
    },
    async summariseCompaction(s) {
      const meta = { sessionId: s.sessionId, trigger: s.trigger, cwd: null, transcriptPath: null };
      const caller = { originProject: s.originProject, requestId: s.requestId, id: s.id };
      return onHandle(hippoRoot, (db) => recordSummary(db, hippoRoot, s.tenantId, meta, { summary: s.summary, items: [...s.items] }, new Date(s.at), caller));
    },
    async writeCompactionItems(write) {
      const { result, written } = onHandle(hippoRoot, (db) => writeItemsInTx(db, write));
      for (const entry of written) writeEntryMirrors(hippoRoot, entry);
      if (written.length > 0) {
        try {
          updateStats(hippoRoot, { remembered: written.length });
        } catch (err) {
          rethrowIfSqliteBlocked(err);
          // The rows are committed; a counter that could not be bumped must not turn that into a failed call.
          log.info(`post-compact: remembered counter not updated: ${errorMessage(err)}`);
        }
      }
      return result;
    },
    async failureOutcome(tenantId, requestId) {
      return onHandle(hippoRoot, (db) => loggedRequest(db, tenantId, requestId));
    },
    async logFailure(event, settle) {
      onHandle(hippoRoot, (db) => (settle ? settleFailureOutcome(db, event.tenantId, event.requestId, event.outcome) : recordFailure(db, event)));
    },
  };
}

/** saveItems' transaction, with the decisions made by the caller's plan; the refusal row is best effort, as gatedWrite's is. */
function writeItemsInTx(db: DatabaseSyncLike, write: CompactionItemsWrite): { result: CompactionItemsResult; written: MemoryEntry[] } {
  const { tenantId, recordId, actor } = write;
  const written: MemoryEntry[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = recordProgress(db, tenantId, recordId);
    if (current?.status !== 'summarised') {
      db.exec('ROLLBACK');
      return { result: { written: current?.itemsWritten ?? 0, alreadyDone: true }, written };
    }
    const tombstones = new Map<string, RejectedValueMark>();
    for (const digest of write.digests) {
      const hit = findRejectedValue(db, tenantId, digest);
      if (hit) tombstones.set(digest, { reason: hit.reason, rejectedAt: hit.rejectedAt });
    }
    const plan = write.plan(selectHeldItems(db, tenantId, write.origins), tombstones);
    for (const step of plan.steps) {
      if ('write' in step) {
        writeEntryDbOnly(db, step.write, { actor });
        written.push(step.write);
      } else {
        audit(db, 'reject_refusal', step.refuse.entryId, { digest: step.refuse.digest, reason: step.refuse.reason }, actor, tenantId);
      }
    }
    strengthenRetrievedOn(db, plan.restated, write.strengthen);
    markItemsDone(db, tenantId, recordId, written.length);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back; keep the original error */ }
    throw err;
  }
  return { result: { written: written.length, alreadyDone: false }, written };
}
