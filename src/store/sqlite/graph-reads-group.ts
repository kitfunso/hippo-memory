// hippo.db's half of the GraphReads store group: one read snapshot around the walk the CLI graph commands run.
import { canReadScope } from '../../recall-scope.js';
import { withGraphReadSnapshot } from '../graph-reads.js';
import { graphViewRows } from '../graph-view-rows.js';
import type { GraphReads, Sync } from '../port.js';

export function sqliteGraphReads(hippoRoot: string): Sync<GraphReads> {
  return {
    graphRows: (tenantId, { entity, limit, reader }) => withGraphReadSnapshot(hippoRoot, (db) => graphViewRows(hippoRoot, db, tenantId, {
      entity,
      limit,
      canRead: reader && ((scope) => scope === null || canReadScope(reader, scope)),
    })),
  };
}

/** The group as a served store answers it: the call runs at once and resolves through a Promise, so a throw rejects as another store's would. */
export function servedGraphReads(sync: Sync<GraphReads>): GraphReads {
  return { graphRows: async (tenantId, query) => sync.graphRows(tenantId, query) };
}
