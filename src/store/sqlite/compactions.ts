// hippo.db's Compactions group: a caller's compaction items, each call on a handle of its own.
import type { DatabaseSyncLike } from '../../db/index.js';
import type { StoreFiles, OnHandle } from './open.js';
import {
  compactionByRequest,
  recordSummary,
  saveItems,
  markSnapshotSaved,
  startCompaction,
} from './compactions-record.js';
import type { Log } from '../local/compaction-hooks.js';
import type { CallerItems, CallerItemsSaved, Compactions } from '../port/compactions.js';
import type { Sync } from './served.js';
import { bound, boundWithFiles, type Bodies } from './bound.js';

/** A caller's items, already scrubbed, under its record: a retry of a finished request answers with the first count,
 * and a `summarised` one is reused. */
function writeCallerItemsAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
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
    recordSummary(db, files.hippoRoot, tenantId, {
      meta,
      text,
      at: new Date(),
      caller: { originProject: req.project, requestId: req.requestId },
    });
  return saveItems(
    db,
    files,
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

/** A caller's items saved, with each note the save logged so the caller can show it. */
function saveCallerItemsAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  req: CallerItems,
): CallerItemsSaved {
  const notes: string[] = [];
  const written = writeCallerItemsAt(db, files, tenantId, req, (message) => {
    notes.push(message);
  });
  return { written, notes };
}

const compactionsAt: Bodies<Omit<Compactions, 'saveCallerItems'>> = {
  start: startCompaction,
  markSnapshotSaved,
};

export function sqliteCompactions(on: OnHandle): Sync<Compactions> {
  return {
    ...bound(on, compactionsAt),
    ...boundWithFiles<Pick<Compactions, 'saveCallerItems'>>(on, { saveCallerItems: saveCallerItemsAt }),
  };
}
