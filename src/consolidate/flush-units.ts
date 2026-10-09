// Splits sleep's queued writes, deletes and dormant moves into components that must each commit whole, so the flush can commit in short transactions.
import type { MemoryEntry } from '../core/memory.js';
import type { DormantMove } from '../store/dormant.js';
import type { FlushComponent } from '../store/delete-and-batch.js';

/** Components that share no id, ordered by each one's first op across writes, then deletes, then dormant moves. */
export function groupFlush(
  writes: readonly MemoryEntry[],
  deletes: readonly string[],
  dormant: readonly DormantMove[],
  units: readonly (readonly string[])[],
): FlushComponent[] {
  const find = unionFind(units);
  const byRoot = new Map<string, { writes: MemoryEntry[]; deletes: string[]; dormant: DormantMove[] }>();
  const componentOf = (id: string) => {
    const root = find(id);
    let component = byRoot.get(root);
    if (!component) byRoot.set(root, (component = { writes: [], deletes: [], dormant: [] }));
    return component;
  };
  for (const entry of writes) componentOf(entry.id).writes.push(entry);
  for (const id of deletes) componentOf(id).deletes.push(id);
  for (const move of dormant) componentOf(move.entry.id).dormant.push(move);
  // A row queued twice keeps its first place and its last version, as one batch always did.
  return [...byRoot.values()].map((c) => ({ ...c, writes: [...new Map(c.writes.map((e) => [e.id, e])).values()] }));
}

/** Maps each id to its unit's representative; an id in no unit is its own. */
function unionFind(units: readonly (readonly string[])[]): (id: string) => string {
  const up = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    for (let next = up.get(root); next !== undefined && next !== root; next = up.get(root)) root = next;
    if (root !== id) up.set(id, root);
    return root;
  };
  for (const unit of units) {
    const head = unit[0];
    if (head === undefined) continue;
    for (const id of unit.slice(1)) {
      const a = find(head);
      const b = find(id);
      if (a !== b) up.set(b, a);
    }
  }
  return find;
}

/** [child, parent] for each queued op on a child whose DAG parent the run removes: a child's change marks the parent
 *  dirty, and one transaction always applied that mark after the parent was gone, so it audited nothing. */
// SHORTCUT: a removed parent and all its changed children commit as one component, so one hold can pass holdMs by a family's size; split by child if a family grows large.
export function familyUnits(
  writes: readonly MemoryEntry[],
  deletes: readonly string[],
  dormant: readonly DormantMove[],
  snapshot: ReadonlyMap<string, MemoryEntry>,
): string[][] {
  const removing = new Set([...deletes, ...dormant.map((m) => m.entry.id)]);
  const units: string[][] = [];
  const link = (id: string, parentId: string | null | undefined): void => {
    if (parentId && removing.has(parentId)) units.push([id, parentId]);
  };
  for (const entry of writes) link(entry.id, entry.dag_parent_id);
  for (const id of deletes) link(id, snapshot.get(id)?.dag_parent_id);
  for (const move of dormant) link(move.entry.id, move.entry.dag_parent_id);
  return units;
}
