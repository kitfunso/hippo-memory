// hippo.db's half of the DagReads store group: the reads session assembly and summary drill-down run today.
import type { DatabaseSyncLike } from '../../db.js';
import type { MemoryEntry } from '../../memory.js';
import { countSessionRawMemories, loadSessionRawMemories, selectChildrenByParent, selectEntriesByIds } from '../entry-reads.js';
import { onHandle, openStore } from '../open.js';
import type { DagReads, DescendantWalk, SummaryDescendants, Sync } from '../port.js';

export function sqliteDagReads(hippoRoot: string): Sync<DagReads> {
  return {
    sessionRawEntries({ tenantId, sessionId, cap, origins }) {
      return loadSessionRawMemories(hippoRoot, sessionId, tenantId, cap, origins);
    },
    sessionRawCount({ tenantId, sessionId, scope, ownScope, origins }) {
      return countSessionRawMemories(hippoRoot, sessionId, tenantId, scope, ownScope, origins);
    },
    summaryWithDescendants(tenantId, id, walk) {
      return onHandle(hippoRoot, (db) => summaryWithDescendantsAt(db, tenantId, id, walk), openStore);
    },
  };
}

// dag_parent_id is not unique to a tree, so `seen` keeps a mislinked row from being listed twice or walked in a loop.
function summaryWithDescendantsAt(db: DatabaseSyncLike, tenantId: string, id: string, { depth, admit }: DescendantWalk): SummaryDescendants | null {
  const summary = selectEntriesByIds(db, [id], tenantId).get(id);
  if (!summary) return null;
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
