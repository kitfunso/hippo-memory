// hippo.db's half of the Quarantine store group: each method is one call on its own handle.
import type { DatabaseSyncLike } from '../../db/index.js';
import { errorFields, errorMessage, log } from '../../util/log.js';
import { readEntryAt } from './entry-reads.js';
import type { OnHandle, StoreFiles } from './open.js';
import { openStore } from './handles.js';
import type { Quarantine, Sync } from '../port.js';
import { approveQuarantinedAt, listQuarantinedAt, rejectQuarantinedAt } from './quarantine.js';
import { writeEntryMirrorsIn } from './entry-writes.js';

/** After the commit, best effort: a failed rewrite leaves the markdown mirror showing the quarantine scope, which still
 * hides the memory. */
function rewriteMirror(db: DatabaseSyncLike, files: StoreFiles, tenantId: string, id: string): void {
  try {
    const restored = readEntryAt(db, id, tenantId);
    if (restored) writeEntryMirrorsIn(files, restored);
  } catch (err) {
    log.error(`quarantine: mirror rewrite failed for ${id}: ${errorMessage(err)}`, errorFields(err));
  }
}

export function sqliteQuarantine(on: OnHandle): Sync<Quarantine> {
  return {
    listQuarantined: (tenantId, query) => on((db) => listQuarantinedAt(db, tenantId, query)),
    approveQuarantined: (tenantId, id, actor) =>
      on((db, files) => {
        const result = approveQuarantinedAt(db, tenantId, id, actor);
        if (result.outcome === 'approved') rewriteMirror(db, files, tenantId, id);
        return result;
      }, openStore),
    rejectQuarantined: (tenantId, id, actor) => on((db) => rejectQuarantinedAt(db, tenantId, id, actor)),
  };
}
