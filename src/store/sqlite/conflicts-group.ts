// hippo.db's Conflicts group: listing and resolving the memory_conflicts rows.
import { listMemoryConflicts, listTouchableConflicts, resolveConflict } from '../conflicts.js';
import type { Conflicts } from '../port-groups.js';
import type { Sync } from '../port.js';

export function sqliteConflicts(hippoRoot: string): Sync<Conflicts> {
  return {
    list: (tenantId, status) => listMemoryConflicts(hippoRoot, status, tenantId ?? undefined),
    listTouchable: (tenantId, status, actor) => listTouchableConflicts(hippoRoot, status, tenantId, actor),
    resolve: (tenantId, request, opts) => resolveConflict(hippoRoot, { ...request, tenantId }, opts),
  };
}

/** The group as a served store answers it: a throw rejects as another store's would. */
export function servedConflicts(sync: Sync<Conflicts>): Conflicts {
  return {
    list: async (tenantId, status) => sync.list(tenantId, status),
    listTouchable: async (tenantId, status, actor) => sync.listTouchable(tenantId, status, actor),
    resolve: async (tenantId, request, opts) => sync.resolve(tenantId, request, opts),
  };
}
