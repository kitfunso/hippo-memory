// A caller's compaction items on hippo.db, for the Compactions group.
import type { DatabaseSyncLike } from '../db/index.js';
import type { StoreFiles } from './open.js';
import { compactionByRequest, recordSummary, saveItems, type Log } from './compactions-record.js';

export interface CallerItems {
  readonly sessionId: string;
  readonly trigger: string | null;
  readonly requestId: string;
  readonly project: string;
  readonly items: readonly string[];
  /** The caller's audit actor and its project's names. */
  readonly owner: string;
  readonly origins: readonly string[];
  /** The config default the caller's items start on. */
  readonly baseHalfLifeDays: number;
}

/** A caller's items, already scrubbed, under its record: a retry of a finished request answers with the first count,
 * and a `summarised` one is reused. */
export function saveCallerItemsAt(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  tenantId: string,
  req: CallerItems,
  log: Log,
): number {
  const earlier = compactionByRequest(db, tenantId, req.requestId, req.sessionId);
  if (earlier !== null && earlier.status !== 'summarised') return earlier.itemsWritten;
  const meta = { sessionId: req.sessionId, trigger: req.trigger, cwd: null, transcriptPath: null };
  const text = { summary: '', items: [...req.items] };
  const record =
    earlier ??
    recordSummary(db, hippoRoot, tenantId, {
      meta,
      text,
      at: new Date(),
      caller: { originProject: req.project, requestId: req.requestId },
    });
  return saveItems(
    db,
    hippoRoot,
    {
      tenantId,
      recordId: record.id,
      sessionId: req.sessionId,
      originProject: record.originProject,
      cwd: null,
      items: record.items,
      caller: { actor: req.owner, origins: req.origins },
    },
    log,
    req.baseHalfLifeDays,
  );
}
