import type { MemoryEntry } from '../../base/memory/memory.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { compareScoredResults } from '../../base/rank/compare.js';
import { churnStaleFactor } from './boosts.js';
import type { ResultCost, SearchResult } from '../../base/rank/search-types.js';

/** When an extracted fact and its source both match, keep only the higher-scoring one (usually the fact). */
export function dedupeExtracted(scored: SearchResult[]): SearchResult[] {
  const seenExtractedFrom = new Set<string>();
  // A dropped source leaves a hole instead of splicing, so each result costs one map step however many came before.
  const slots: Array<SearchResult | null> = [];
  const slotsOfId = new Map<string, number[]>();
  const keep = (result: SearchResult): void => {
    const held = slotsOfId.get(result.entry.id);
    if (held) held.push(slots.length);
    else slotsOfId.set(result.entry.id, [slots.length]);
    slots.push(result);
  };
  for (const result of scored) {
    const entry = result.entry;
    if (entry.extractedFrom) {
      seenExtractedFrom.add(entry.extractedFrom);
      const sourceSlot = slotsOfId.get(entry.extractedFrom)?.shift();
      if (sourceSlot !== undefined) slots[sourceSlot] = null;
      keep(result);
    } else if (!seenExtractedFrom.has(entry.id)) {
      keep(result);
    }
  }
  return slots.filter((r): r is SearchResult => r !== null);
}

const DAG_CHILD_SCORE_FACTOR = 0.9;

/** DAG drill-down: a matched summary pulls its children from `pool` in at 0.9x its score; sorts `results` in place. */
export function withDagChildren(results: SearchResult[], pool: MemoryEntry[]): SearchResult[] {
  const summaryIds = new Set(results.filter((r) => r.entry.tags.includes('dag-summary')).map((r) => r.entry.id));
  if (summaryIds.size === 0) return results;
  const children = pool.filter((e) => e.dagParentId && summaryIds.has(e.dagParentId));
  // The first result of an id wins, and a child added below counts for the rows after it.
  const resultById = new Map<string, SearchResult>();
  for (const r of results) if (!resultById.has(r.entry.id)) resultById.set(r.entry.id, r);
  for (const child of children) {
    if (resultById.has(child.id)) continue;
    const parentResult = child.dagParentId ? resultById.get(child.dagParentId) : undefined;
    const childScore = parentResult ? parentResult.score * DAG_CHILD_SCORE_FACTOR * churnStaleFactor(child) : 0;
    const added = { entry: child, score: childScore, bm25: 0, cosine: 0, tokens: estimateTokens(child.content) };
    results.push(added);
    resultById.set(child.id, added);
  }
  results.sort(compareScoredResults);
  return results;
}

// Skip-and-continue, with the first minResults kept whatever they cost; one loop so every engine spends alike.
export function fitBudget<T extends SearchResult>(
  ordered: T[],
  budget: number,
  minResults: number,
  cost?: ResultCost,
): T[] {
  const results: T[] = [];
  let used = 0;
  for (const r of ordered) {
    const tokens = cost ? cost(r) : r.tokens;
    if (results.length >= minResults && used + tokens > budget) continue;
    used += tokens;
    results.push(r);
  }
  return results;
}
