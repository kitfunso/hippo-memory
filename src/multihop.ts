import type { MemoryEntry } from './memory.js';
import { search, type SearchResult } from './search.js';

export function multihopSearch(
  query: string,
  entries: MemoryEntry[],
  options: { budget?: number; now?: Date; hippoRoot?: string; minResults?: number; includeSuperseded?: boolean; asOf?: string } = {},
): SearchResult[] {
  const pass1 = search(query, entries, { ...options, budget: (options.budget ?? 4000) * 2 });
  const topK = pass1.slice(0, 10);

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

  if (newEntities.length === 0) return pass1;

  const followUpQuery = newEntities.join(' ') + ' ' + query;
  const pass2 = search(followUpQuery, entries, options);

  const merged = new Map<string, SearchResult>();
  for (const r of [...pass1, ...pass2]) {
    const existing = merged.get(r.entry.id);
    if (!existing || r.score > existing.score) {
      merged.set(r.entry.id, r);
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score);
}
