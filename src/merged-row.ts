// A sleep-merged row copies its sources' texts, so retiring a text (reject, or superseding its source) must reach the row too.
// SHORTCUT: reject rewrites merged rows at once; supersede and `resolve --reject-loser` wait for the next sleep's check.
import { generateId, type MemoryEntry } from './memory.js';
import { duplicateKey, heldTexts, mergedText } from './same-text.js';

/** The row that replaces a merged row once its retired texts leave: undefined when it holds none, null when nothing else is left. */
export function mergedSuccessor(
  row: MemoryEntry,
  retired: (text: string) => boolean,
  retiredIds: ReadonlySet<string>,
): MemoryEntry | null | undefined {
  const texts = heldTexts(row);
  const kept = texts.filter((t) => !retired(t));
  if (kept.length === texts.length) return undefined;
  if (kept.length === 0) return null;
  const count = `${kept.length} related ${kept.length === 1 ? 'memory' : 'memories'}`;
  const header = row.content.slice(0, row.content.indexOf('\n\n')).replace(/\d+ related memor(?:y|ies)/, count);
  // A new id, as a fresh merge would get; age and half-life carry over so the rewrite buys the row no extra life.
  return {
    ...row,
    id: generateId('sem'),
    content: mergedText(header, kept),
    parents: row.parents.filter((id) => !retiredIds.has(id)),
    conflicts_with: [],
  };
}

/** Sleep's check on a merged row: drops texts whose source was superseded since the merge, or that a rejection now covers. */
export function successorAfterRetirement(
  row: MemoryEntry,
  byId: ReadonlyMap<string, MemoryEntry>,
  rejected: (text: string) => boolean,
): MemoryEntry | null | undefined {
  if (row.source !== 'consolidation' || row.superseded_by) return undefined;
  const sources = row.parents.flatMap((id) => byId.get(id) ?? []);
  const retiredIds = new Set(sources.filter((s) => Boolean(s.superseded_by) || rejected(s.content)).map((s) => s.id));
  const live = new Set(sources.filter((s) => !retiredIds.has(s.id)).map((s) => duplicateKey(s.content)));
  const gone = new Set(sources.filter((s) => retiredIds.has(s.id)).map((s) => duplicateKey(s.content)));
  const retired = (text: string): boolean => (gone.has(duplicateKey(text)) && !live.has(duplicateKey(text))) || rejected(text);
  return mergedSuccessor(row, retired, retiredIds);
}
