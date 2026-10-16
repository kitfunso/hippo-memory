// hippo.db's half of the GraphReads store group: one read snapshot around the walk the CLI graph commands run.
import { canReadScope } from '../../core/recall-scope.js';
import {
  loadEntitiesByIds, loadEntitiesByMemoryId, loadNeighborRelations, withGraphReadSnapshot,
} from '../graph-reads.js';
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
    entitiesForMemories: (tenantId, memoryIds) => loadEntitiesByMemoryId(hippoRoot, tenantId, memoryIds),
    entitiesByIds: (tenantId, ids) => loadEntitiesByIds(hippoRoot, tenantId, ids),
    neighborRelations: (tenantId, entityIds, { limit }) =>
      loadNeighborRelations(hippoRoot, tenantId, entityIds, { limit }),
  };
}
