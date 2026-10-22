// The in-memory recall candidates: hippo.db's three tiers, whole-word matches, then part-word matches among the newest
// rows, then every admitted row, over the same admission rule its SQL applies.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { recallScopeFilter } from '../../base/scope/recall-scope.js';
import { tokenize } from '../../base/util/tokenize.js';
import type { RecallSearchArgs } from '../port/recall-writes.js';
import { byBytes, oldestFirst } from '../rules/order.js';
import { asciiFolded } from './rows.js';
import type { MemoryTables } from './tables.js';
import { admitsCandidate } from './vectors.js';
import { ftsMatches } from '../rules/fts.js';
import { LIKE_WINDOW_ROWS } from '../rules/windows.js';

/** memories.updated_at, which both match tiers order by before created; '' sorts as hippo.db's NULL does, last. */
const updatedOf = (t: MemoryTables, entry: MemoryEntry): string => t.updatedAt.get(entry.id) ?? '';

/** Newest updated_at first, then newest created, then content and id: hippo.db's LIKE tier order. */
const newestFirst =
  (t: MemoryTables) =>
  (a: MemoryEntry, b: MemoryEntry): number =>
    byBytes(updatedOf(t, b), updatedOf(t, a)) ||
    byBytes(b.created, a.created) ||
    byBytes(a.content, b.content) ||
    byBytes(a.id, b.id);

/** As hippo.db's FTS join: best bm25 first, then updated_at newest first, content and id; each row keeps its score. */
function wholeWordMatches(t: MemoryTables, admitted: readonly MemoryEntry[], terms: readonly string[], limit: number) {
  const byUpdated = (a: MemoryEntry, b: MemoryEntry): number => byBytes(updatedOf(t, b), updatedOf(t, a));
  const matches = ftsMatches(t.entries.values(), admitted, terms).sort(
    (a, b) =>
      a.bm25 - b.bm25 ||
      byUpdated(a.entry, b.entry) ||
      byBytes(a.entry.content, b.entry.content) ||
      byBytes(a.entry.id, b.entry.id),
  );
  return matches.slice(0, limit).map(({ entry, bm25 }): MemoryEntry => ({ ...entry, bm25Score: bm25 }));
}

/** Substrings of the content or tags JSON among the newest admitted rows, as hippo.db's LIKE window reads them. */
function partWordMatches(t: MemoryTables, admitted: readonly MemoryEntry[], terms: readonly string[], limit: number) {
  // Newest by created, as the tenant's index reads them; a tie goes to the row written last, as its rowid does.
  const window = [...admitted].reverse().sort((a, b) => byBytes(b.created, a.created));
  const hits = window.slice(0, Math.max(limit, LIKE_WINDOW_ROWS)).filter((entry) => {
    const texts = [asciiFolded(entry.content), asciiFolded(JSON.stringify(entry.tags))];
    return terms.some((term) => texts.some((text) => text.includes(term)));
  });
  return hits.sort(newestFirst(t)).slice(0, limit);
}

export function searchRecallIn(t: MemoryTables, query: string, args: RecallSearchArgs): MemoryEntry[] {
  const { limit, tenantId, requestedScope, explicitScopeMode, ownScope } = args;
  const spec = {
    tenantId,
    scope: recallScopeFilter(requestedScope, explicitScopeMode, ownScope),
    includeSuperseded: args.includeSuperseded,
    origin: args.originProjects,
  };
  const admitted = [...t.entries.values()].filter((entry) => admitsCandidate(entry, spec));
  const everyRow = (): MemoryEntry[] => [...admitted].sort(oldestFirst).slice(0, limit);
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return structuredClone(everyRow());
  const whole = wholeWordMatches(t, admitted, terms, limit);
  if (whole.length > 0) return structuredClone(whole);
  const part = partWordMatches(t, admitted, terms, limit);
  return structuredClone(part.length > 0 ? part : everyRow());
}
