// hippo.db's half of the Compactions store group: each call on a handle of its own.
import { saveCallerItemsAt } from '../compaction-caller.js';
import { markSnapshotSaved, startCompaction } from '../compactions-record.js';
import { onHandle } from '../open.js';
import type { Compactions } from '../port/compactions.js';
import type { Sync } from '../port.js';

export function sqliteCompactions(hippoRoot: string): Sync<Compactions> {
  return {
    start: (tenantId, start) => onHandle(hippoRoot, (db) => startCompaction(db, tenantId, start)),
    markSnapshotSaved: (tenantId, recordId) => onHandle(hippoRoot, (db) => markSnapshotSaved(db, tenantId, recordId)),
    saveCallerItems: (tenantId, req) => {
      const notes: string[] = [];
      const note = (message: string): void => { notes.push(message); };
      const written = onHandle(hippoRoot, (db) => saveCallerItemsAt(db, hippoRoot, tenantId, req, note));
      return { written, notes };
    },
  };
}
