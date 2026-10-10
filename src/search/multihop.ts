import { compareScoresDesc } from '../core/compare.js';
import type { MemoryEntry } from '../core/memory.js';
import { fitBudget } from './finalize.js';
import { search } from './bm25-search.js';
import { DEFAULT_RECALL_BUDGET, type ResultCost, type SearchResult } from '../core/search-types.js';

const PASS1_TOP_K = 10;

export function multihopSearch(
  query: string,
  entries: MemoryEntry[],
  options: { budget?: number; now?: Date; hippoRoot?: string; minResults?: number; cost?: ResultCost; includeSuperseded?: boolean; asOf?: string } = {},
): SearchResult[] {
  const budget = options.budget ?? DEFAULT_RECALL_BUDGET;
  // Pass 1 searches wide to find entities, so each return fits the caller's budget, as search() does.
  const fit = (ordered: SearchResult[]): SearchResult[] => fitBudget(ordered, budget, options.minResults ?? 1, options.cost);
  const pass1 = search(query, entries, { ...options, budget: budget * 2 });
  const topK = pass1.slice(0, PASS1_TOP_K);

  if (topK.length === 0) return [];

  const entityTags = new Set<string>();
  for (const r of topK) {
    for (const tag of r.entry.tags) {
      if (tag.startsWith('speaker:') || tag.startsWith('topic:')) {
        entityTags.add(tag);
      }
    }
  }

  const queryLower = query.toLowerCase();
  const newEntities = [...entityTags]
    .map((t) => t.split(':')[1])
    .filter((e) => !queryLower.includes(e.toLowerCase()));

  if (newEntities.length === 0) return fit(pass1);

  const followUpQuery = newEntities.join(' ') + ' ' + query;
  const pass2 = search(followUpQuery, entries, options);

  const merged = new Map<string, SearchResult>();
  for (const r of [...pass1, ...pass2]) {
    const existing = merged.get(r.entry.id);
    if (!existing || r.score > existing.score) {
      merged.set(r.entry.id, r);
    }
  }

  // PLAIN stable score sort on purpose -- pass1/pass2 inputs are
  // deterministically ordered (search() carries the content tail), stability
  // inherits that, and ties keep pass-1 results ahead of pass-2 follow-ups.
  return fit([...merged.values()].sort((a, b) => compareScoresDesc(a.score, b.score)));
}
