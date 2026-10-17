// hippo.db's half of the DagReads store group: the reads session assembly and summary drill-down run today.
import type { DatabaseSyncLike } from '../../db/index.js';
import type { MemoryEntry } from '../../core/memory.js';
import { pagedDescendants } from '../descendant-page.js';
import {
  countSessionRawMemoriesAt,
  loadSessionRawMemoriesAt,
  selectChildrenByParent,
  selectEntriesByIds,
} from '../entry-reads.js';
import { type OnHandle, openStore } from '../open.js';
import type { DagReads, DescendantWalk, SummaryDescendants, Sync } from '../port.js';

export function sqliteDagReads(on: OnHandle): Sync<DagReads> {
  return {
    sessionRawEntries: ({ tenantId, sessionId, cap, origins }) =>
      on((db) => loadSessionRawMemoriesAt(db, sessionId, tenantId, cap, origins), openStore),
    sessionRawCount: ({ tenantId, sessionId, scope, ownScope, origins }) =>
      on((db) => countSessionRawMemoriesAt(db, sessionId, tenantId, scope, ownScope, origins), openStore),
    summaryWithDescendants: (tenantId, id, walk) =>
      on((db) => summaryWithDescendantsAt(db, tenantId, id, walk), openStore),
  };
}

// dag_parent_id is not unique to a tree, so `seen` keeps a mislinked row from being listed twice or walked in a loop.
function summaryWithDescendantsAt(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  { depth, admit, page }: DescendantWalk,
): SummaryDescendants | null {
  const summary = selectEntriesByIds(db, [id], tenantId).get(id);
  if (!summary) return null;
  if (page) return pagedDescendants(db, { tenantId, summary, depth, page }, admit(summary));
  const levels: MemoryEntry[][] = [];
  const seen = new Set<string>([id]);
  let parents = admit(summary) ? [id] : [];
  for (let level = 0; level < depth && parents.length > 0; level++) {
    const childrenOf = selectChildrenByParent(db, parents, tenantId);
    const admitted: MemoryEntry[] = [];
    for (const parentId of parents) {
      for (const child of childrenOf.get(parentId) ?? []) {
        if (seen.has(child.id) || !admit(child)) continue;
        seen.add(child.id);
        admitted.push(child);
      }
    }
    if (admitted.length === 0) break;
    levels.push(admitted);
    parents = admitted.map((row) => row.id);
  }
  return { summary, levels };
}
