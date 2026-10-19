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
import type { Log } from '../port/compaction-hooks.js';
import type { CallerItems, Compactions } from '../port/compactions.js';
import type { Sync } from '../port.js';

/** A caller's items, already scrubbed, under its record: a retry of a finished request answers with the first count,
 * and a `summarised` one is reused. */
function saveCallerItemsAt(
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

export function sqliteCompactions(on: OnHandle): Sync<Compactions> {
  return {
    start: (tenantId, start) => on((db) => startCompaction(db, tenantId, start)),
    markSnapshotSaved: (tenantId, recordId) => on((db) => markSnapshotSaved(db, tenantId, recordId)),
    saveCallerItems: (tenantId, req) => {
      const notes: string[] = [];
      const note = (message: string): void => {
        notes.push(message);
      };
      const written = on((db, files) => saveCallerItemsAt(db, files, tenantId, req, note));
      return { written, notes };
    },
  };
}
