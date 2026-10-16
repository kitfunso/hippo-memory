// hippo.db's half of the GraphReads store group: one read snapshot around the walk the CLI graph commands run.
import { canReadScope } from '../../core/recall-scope.js';
import { withGraphReadSnapshot } from '../graph-reads.js';
import { graphViewRows } from '../graph-view-rows.js';
import type { GraphReads, Sync } from '../port.js';

export function sqliteGraphReads(hippoRoot: string): Sync<GraphReads> {
  return {
    graphRows: (tenantId, { entity, limit, reader }) =>
      withGraphReadSnapshot(hippoRoot, (db) =>
        graphViewRows(hippoRoot, db, tenantId, {
          entity,
          limit,
          canRead: reader && ((scope) => scope === null || canReadScope(reader, scope)),
        }),
      ),
  };
}
