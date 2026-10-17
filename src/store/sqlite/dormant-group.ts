// hippo.db's Dormant group: the memories sleep set aside, listed, restored or forgotten for good.
import {
  forgetDormantMemoryAt, holdsDormantMemoryAt, loadDormantMemoriesAt, restoreDormantMemoryAt,
} from '../dormant.js';
import { updateStatsUnlessBusyAt } from '../index-and-stats.js';
import type { Dormant } from '../port-groups.js';
import type { Sync } from '../port.js';
import { touchableScopeSql } from '../rule-sql.js';
import { type OnHandle, openStore } from '../open.js';

export function sqliteDormant(on: OnHandle): Sync<Dormant> {
  return {
    list: (tenantId, ownScope, opts) =>
      on((db) => loadDormantMemoriesAt(db, tenantId, opts, touchableScopeSql('', ownScope))),
    holds: (tenantId, ownScope, id) =>
      on((db) => holdsDormantMemoryAt(db, tenantId, id, touchableScopeSql('', ownScope))),
    restore: (tenantId, request) => on((db, files) => restoreDormantMemoryAt(db, files, { ...request, tenantId })),
    forget(tenantId, ownScope, id, actor) {
      const admit = touchableScopeSql('', ownScope);
      return on((db, files) => {
        if (!forgetDormantMemoryAt(db, { tenantId, id, actor, admit })) return false;
        // Counted like every other permanent removal (forget, archiveRaw).
        updateStatsUnlessBusyAt(db, files, { forgotten: 1 }, `removed ${id}`);
        return true;
      }, openStore);
    },
  };
}
