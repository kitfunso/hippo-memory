// hippo.db's half of the Quarantine store group: each method is one call on its own handle.
import { errorMessage, log } from '../../util/log.js';
import { readEntry } from '../entry-reads.js';
import { writeEntryMirrors } from '../entry-writes.js';
import { onHandle } from '../open.js';
import type { Quarantine, Sync } from '../port.js';
import { approveQuarantinedAt, listQuarantinedAt, rejectQuarantinedAt } from '../quarantine.js';

/** After the commit, best effort: a failed rewrite leaves the markdown mirror showing the quarantine scope, which still hides the memory. */
function rewriteMirror(hippoRoot: string, tenantId: string, id: string): void {
  try {
    const restored = readEntry(hippoRoot, id, tenantId);
    if (restored) writeEntryMirrors(hippoRoot, restored);
  } catch (err) {
    log.error(`quarantine: mirror rewrite failed for ${id}: ${errorMessage(err)}`);
  }
}

export function sqliteQuarantine(hippoRoot: string): Sync<Quarantine> {
  return {
    listQuarantined: (tenantId, query) => onHandle(hippoRoot, (db) => listQuarantinedAt(db, tenantId, query)),
    approveQuarantined(tenantId, id, actor) {
      const result = onHandle(hippoRoot, (db) => approveQuarantinedAt(db, tenantId, id, actor));
      if (result.outcome === 'approved') rewriteMirror(hippoRoot, tenantId, id);
      return result;
    },
    rejectQuarantined: (tenantId, id, actor) => onHandle(hippoRoot, (db) => rejectQuarantinedAt(db, tenantId, id, actor)),
  };
}

/** The group as a served store answers it: each call runs at once and resolves through a Promise, so a throw rejects as another store's would. */
export function servedQuarantine(sync: Sync<Quarantine>): Quarantine {
  return {
    listQuarantined: async (tenantId, query) => sync.listQuarantined(tenantId, query),
    approveQuarantined: async (tenantId, id, actor) => sync.approveQuarantined(tenantId, id, actor),
    rejectQuarantined: async (tenantId, id, actor) => sync.rejectQuarantined(tenantId, id, actor),
  };
}
