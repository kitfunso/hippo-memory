// hippo.db's Conflicts group: listing and resolving the memory_conflicts rows.
import { listMemoryConflictsAt, listTouchableConflictsAt, resolveConflictAt } from '../conflicts.js';
import { type OnHandle, openStore } from '../open.js';
import type { Conflicts } from '../port-groups.js';
import type { Sync } from '../port.js';

export function sqliteConflicts(on: OnHandle): Sync<Conflicts> {
  return {
    list: (tenantId, status) => on((db) => listMemoryConflictsAt(db, status, tenantId ?? undefined), openStore),
    listTouchable: (tenantId, status, actor) =>
      on((db) => listTouchableConflictsAt(db, status, tenantId, actor), openStore),
    resolve: (tenantId, request, opts) =>
      on((db, files) => resolveConflictAt(db, files, { ...request, tenantId }, opts), openStore),
  };
}
