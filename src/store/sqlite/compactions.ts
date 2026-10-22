// hippo.db's Compactions group: a caller's compaction items, each call on a handle of its own.
import type { DatabaseSyncLike } from '../../db/index.js';
import type { Handles, StoreFiles } from './open.js';
import {
  compactionByRequest,
  recordSummary,
  saveItems,
  markSnapshotSaved,
  startCompaction,
  type Log,
} from './compactions-record.js';
import type { CallerItems, CallerItemsSaved, Compactions } from '../port/capture.js';
import { bound, type Bodies } from './bound.js';

/** A caller's items, already scrubbed, under its record: a retry of a finished request answers with the first count,
 * and a `summarised` one is reused. */
function writeCallerItems(
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
function saveCallerItems(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  req: CallerItems,
): CallerItemsSaved {
  const notes: string[] = [];
  const written = writeCallerItems(db, files, tenantId, req, (message) => {
    notes.push(message);
  });
  return { written, notes };
}

const compactionsBodies: Bodies<Omit<Compactions, 'saveCallerItems'>> = {
  start: startCompaction,
  markSnapshotSaved,
};

export function sqliteCompactions({ on, files }: Handles): Compactions {
  return {
    ...bound(on, compactionsBodies),
    ...bound<Pick<Compactions, 'saveCallerItems'>>(on, {
      saveCallerItems: (db, ...args) => saveCallerItems(db, files, ...args),
    }),
  };
}
