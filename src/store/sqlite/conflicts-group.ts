// hippo.db's Conflicts group: listing and resolving the memory_conflicts rows.
import { conflictByIdAt, conflictPageAt, resolveConflictAt } from '../conflicts.js';
import { type OnHandle, openStore } from '../open.js';
import type { Conflicts } from '../port-groups.js';
import type { Sync } from '../port.js';

export function sqliteConflicts(on: OnHandle): Sync<Conflicts> {
  return {
    list: (query) => on((db) => conflictPageAt(db, query), openStore),
    get: (tenantId, conflictId) => on((db) => conflictByIdAt(db, tenantId, conflictId), openStore),
    resolve: (tenantId, resolution) => on((db, files) => resolveConflictAt(db, files, tenantId, resolution), openStore),
  };
}
