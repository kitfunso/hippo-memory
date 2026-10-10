// A caller's compaction calls on a handle of its own, for code that has a folder and no connection.
import { onHandle } from './open.js';
import {
  compactionByRequest, markSnapshotSaved, recordSummary, saveItems, startCompaction, type CompactionStart, type Log,
} from './compactions-record.js';

/** {@link startCompaction} on a handle of its own, for a caller's request. */
export function startCompactionAt(hippoRoot: string, tenantId: string, start: CompactionStart): string {
  return onHandle(hippoRoot, (db) => startCompaction(db, tenantId, start));
}

/** {@link markSnapshotSaved} on a handle of its own, for a caller's request. */
export function markSnapshotSavedAt(hippoRoot: string, tenantId: string, recordId: string): void {
  onHandle(hippoRoot, (db) => markSnapshotSaved(db, tenantId, recordId));
}

export interface CallerItems {
  readonly sessionId: string;
  readonly trigger: string | null;
  readonly requestId: string;
  readonly project: string;
  readonly items: readonly string[];
  /** The caller's audit actor and its project's names. */
  readonly owner: string;
  readonly origins: readonly string[];
}

/** A caller's items, already scrubbed, under its record: a retry of a finished request answers with the first count, and a `summarised` one is reused. */
export function saveCallerItems(hippoRoot: string, tenantId: string, req: CallerItems, log: Log): number {
  return onHandle(hippoRoot, (db) => {
    const earlier = compactionByRequest(db, tenantId, req.requestId, req.sessionId);
    if (earlier !== null && earlier.status !== 'summarised') return earlier.itemsWritten;
    const meta = { sessionId: req.sessionId, trigger: req.trigger, cwd: null, transcriptPath: null };
    const text = { summary: '', items: [...req.items] };
    const record = earlier ?? recordSummary(db, hippoRoot, tenantId, {
      meta, text, at: new Date(), caller: { originProject: req.project, requestId: req.requestId },
    });
    return saveItems(db, hippoRoot, {
      tenantId, recordId: record.id, sessionId: req.sessionId, originProject: record.originProject, cwd: null,
      items: record.items, caller: { actor: req.owner, origins: req.origins },
    }, log);
  });
}
