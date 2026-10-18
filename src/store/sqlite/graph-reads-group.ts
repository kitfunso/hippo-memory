// hippo.db's half of the GraphReads store group: one read snapshot around the walk the CLI graph commands run.
import { canReadScope } from '../../core/recall-scope.js';
import {
  loadEntitiesByIdsAt,
  loadEntitiesByMemoryIdAt,
  loadNeighborRelationsAt,
  loadStoredGraphAt,
  withGraphReadSnapshotAt,
} from './graph-reads.js';
import { graphViewRows } from '../graph-view-rows.js';
import type { GraphReads, Sync } from '../port.js';
import { type OnHandle } from './open.js';

export function sqliteGraphReads(on: OnHandle): Sync<GraphReads> {
  return {
    graphRows: (tenantId, { entity, limit, reader }) =>
      on((db) =>
        withGraphReadSnapshotAt(db, (snapshot) =>
          graphViewRows(snapshot, tenantId, {
            entity,
            limit,
            canRead: reader && ((scope) => scope === null || canReadScope(reader, scope)),
          }),
        ),
      ),
    entitiesForMemories: (tenantId, memoryIds) => on((db) => loadEntitiesByMemoryIdAt(db, tenantId, memoryIds)),
    entitiesByIds: (tenantId, ids) => on((db) => loadEntitiesByIdsAt(db, tenantId, ids)),
    neighborRelations: (tenantId, entityIds, { limit }) =>
      on((db) => loadNeighborRelationsAt(db, tenantId, entityIds, { limit })),
    storedGraph: (tenantId, memoryIds) => on((db) => loadStoredGraphAt(db, tenantId, memoryIds)),
  };
}
