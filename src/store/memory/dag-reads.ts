// The in-memory DagReads group: a session's raw rows and a summary's descendants, under the recall admission rules.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { passesScopeFilterForRecall } from '../../base/scope/recall-scope.js';
import { descendantAdmits } from '../../base/scope/read-admission.js';
import type { DagReads, DescendantWalk, SessionRawQuery, SummaryDescendants } from '../port/context-reads.js';
import { oldestFirst } from '../rules/order.js';
import type { MemoryTables } from './tables.js';

function sessionRaws(t: MemoryTables, { tenantId, sessionId, origins }: SessionRawQuery): MemoryEntry[] {
  if (!sessionId) return [];
  const origin = (e: MemoryEntry): string | null => e.originProject ?? null;
  return [...t.entries.values()]
    .filter(
      (e) => e.tenantId === tenantId && e.kind === 'raw' && e.sourceSessionId === sessionId && e.supersededBy === null,
    )
    .filter((e) => origins === undefined || origin(e) === '' || (origin(e) !== null && origins.includes(origin(e)!)))
    .sort(oldestFirst);
}

function descendantsIn(t: MemoryTables, tenantId: string, id: string, walk: DescendantWalk): SummaryDescendants | null {
  const { depth, admit, minSummaryLevel } = walk;
  const mine = [...t.entries.values()].filter((e) => e.tenantId === tenantId);
  const found = mine.find((e) => e.id === id);
  if (!found) return null;
  const summary = structuredClone(found);
  const levels: MemoryEntry[][] = [];
  const listed = new Set<string>([id]);
  const walked = descendantAdmits(summary, admit) && (summary.dagLevel ?? 0) >= (minSummaryLevel ?? 0);
  let above = walked ? [id] : [];
  while (levels.length < depth && above.length > 0) {
    const level: MemoryEntry[] = [];
    for (const parentId of above) {
      const children = mine.filter((e) => e.dagParentId === parentId).sort(oldestFirst);
      for (const child of children) {
        if (listed.has(child.id) || !descendantAdmits(child, admit)) continue;
        listed.add(child.id);
        level.push(structuredClone(child));
      }
    }
    if (level.length === 0) break;
    levels.push(level);
    above = level.map((row) => row.id);
  }
  return { summary, levels };
}

export function memoryDagReads(t: MemoryTables): DagReads {
  return {
    async sessionRawEntries(query) {
      const all = sessionRaws(t, query);
      return structuredClone(query.cap > 0 ? all.slice(-query.cap) : all);
    },
    async sessionRawCount(query) {
      const exact = query.scope !== undefined && query.scope !== '';
      const admitted = (e: MemoryEntry): boolean =>
        exact ? e.scope === query.scope : passesScopeFilterForRecall(e.scope, undefined, query.ownScope);
      return sessionRaws(t, query).filter(admitted).length;
    },
    summaryWithDescendants: async (tenantId, id, walk) => descendantsIn(t, tenantId, id, walk),
  };
}
