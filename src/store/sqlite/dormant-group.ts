// hippo.db's Dormant group: the memories sleep set aside, listed, restored or forgotten for good.
import { forgetDormantMemory, holdsDormantMemory, loadDormantMemories, restoreDormantMemory } from '../dormant.js';
import { updateStatsUnlessBusy } from '../index-and-stats.js';
import type { Dormant } from '../port-groups.js';
import type { Sync } from '../port.js';
import { touchableScopeSql } from '../rule-sql.js';

export function sqliteDormant(hippoRoot: string): Sync<Dormant> {
  return {
    list: (tenantId, ownScope, opts) =>
      loadDormantMemories(hippoRoot, tenantId, opts, touchableScopeSql('', ownScope)),
    holds: (tenantId, ownScope, id) => holdsDormantMemory(hippoRoot, tenantId, id, touchableScopeSql('', ownScope)),
    restore: (tenantId, request) => restoreDormantMemory(hippoRoot, { ...request, tenantId }),
    forget(tenantId, ownScope, id, actor) {
      const admit = touchableScopeSql('', ownScope);
      if (!forgetDormantMemory(hippoRoot, { tenantId, id, actor, admit })) return false;
      // Counted like every other permanent removal (forget, archiveRaw).
      updateStatsUnlessBusy(hippoRoot, { forgotten: 1 }, `removed ${id}`);
      return true;
    },
  };
}

/** The group as a served store answers it: a throw rejects as another store's would. */
export function servedDormant(sync: Sync<Dormant>): Dormant {
  return {
    list: async (tenantId, ownScope, opts) => sync.list(tenantId, ownScope, opts),
    holds: async (tenantId, ownScope, id) => sync.holds(tenantId, ownScope, id),
    restore: async (tenantId, request) => sync.restore(tenantId, request),
    forget: async (tenantId, ownScope, id, actor) => sync.forget(tenantId, ownScope, id, actor),
  };
}
