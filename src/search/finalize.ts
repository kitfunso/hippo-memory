import type { MemoryEntry } from '../core/memory.js';
import { estimateTokens } from '../util/token-text.js';
import { compareScoredResults } from '../core/compare.js';
import { churnStaleFactor } from './boosts.js';
import type { ResultCost, SearchResult } from '../core/search-types.js';

/** When an extracted fact and its source both match, keep only the higher-scoring one (usually the fact). */
export function dedupeExtracted(scored: SearchResult[]): SearchResult[] {
  const seenExtractedFrom = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of scored) {
    const entry = result.entry;
    if (entry.extracted_from) {
      seenExtractedFrom.add(entry.extracted_from);
      const sourceIdx = deduped.findIndex((d) => d.entry.id === entry.extracted_from);
      if (sourceIdx >= 0) deduped.splice(sourceIdx, 1);
      deduped.push(result);
    } else if (!seenExtractedFrom.has(entry.id)) {
      deduped.push(result);
    }
  }
  return deduped;
}

const DAG_CHILD_SCORE_FACTOR = 0.9;

/** DAG drill-down: a matched summary pulls its children from `pool` in at 0.9x its score; sorts `results` in place. */
export function withDagChildren(results: SearchResult[], pool: MemoryEntry[]): SearchResult[] {
  const summaryIds = results.filter((r) => r.entry.tags.includes('dag-summary')).map((r) => r.entry.id);
  if (summaryIds.length === 0) return results;
  const children = pool.filter((e) => e.dag_parent_id && summaryIds.includes(e.dag_parent_id));
  for (const child of children) {
    if (results.some((r) => r.entry.id === child.id)) continue;
    const parentResult = results.find((r) => r.entry.id === child.dag_parent_id);
    const childScore = parentResult ? parentResult.score * DAG_CHILD_SCORE_FACTOR * churnStaleFactor(child) : 0;
    results.push({ entry: child, score: childScore, bm25: 0, cosine: 0, tokens: estimateTokens(child.content) });
  }
  results.sort(compareScoredResults);
  return results;
}

// Skip-and-continue, with the first minResults kept whatever they cost; one loop so every engine spends alike.
export function fitBudget<T extends SearchResult>(ordered: T[], budget: number, minResults: number, cost?: ResultCost): T[] {
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
