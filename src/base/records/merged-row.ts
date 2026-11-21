// A sleep-merged row copies its sources' texts, so retiring a text (reject, or superseding its
// source) must reach the row too. SHORTCUT: reject rewrites merged rows at once, live and dormant;
// supersede and `resolve --reject-loser` wait for the next sleep's check, which sees a dormant row
// only once restored.
import { generateId, type MemoryEntry } from '../memory/entry.js';
import { duplicateKey, heldTexts, mergedText } from '../util/same-text.js';
import { isSuperseded } from '../memory/liveness.js';
import { isPersonalScope } from '../scope/recall-scope.js';
import { INSTRUCTION_LIKE_TAG, mergeFormsInstruction } from '../trust/instruction-detect.js';

/**
 * The row that replaces a merged row once its retired texts leave: undefined when it holds none,
 * null when nothing else is left.
 */
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
  const header = row.content
    .slice(0, row.content.indexOf('\n\n'))
    .replace(/\d+ related memor(?:y|ies)/, count);
  // The kept texts meet the union tags again, which can form a pattern; an own-tag list is not known for a held text,
  // so [] stands in, and a row merged by an earlier release is covered too.
  const needsFrame =
    !isPersonalScope(row.scope) &&
    !row.tags.includes(INSTRUCTION_LIKE_TAG) &&
    mergeFormsInstruction(
      kept.map((t) => ({ content: t, tags: [] })),
      row.tags,
    );
  // A new id, as a fresh merge would get; age and half-life carry over so the rewrite buys the row
  // no extra life.
  return {
    ...row,
    id: generateId('sem'),
    tags: needsFrame ? [...row.tags, INSTRUCTION_LIKE_TAG].sort() : row.tags,
    content: mergedText(header, kept),
    parents: row.parents.filter((id) => !retiredIds.has(id)),
    conflictsWith: [],
  };
}

/**
 * Sleep's check on a merged row: drops texts whose source was superseded since the merge, or that a
 * rejection now covers.
 */
export function successorAfterRetirement(
  row: MemoryEntry,
  byId: ReadonlyMap<string, MemoryEntry>,
  rejected: (text: string) => boolean,
): MemoryEntry | null | undefined {
  if (row.source !== 'consolidation' || isSuperseded(row)) return undefined;
  const sources = row.parents.flatMap((id) => byId.get(id) ?? []);
  const retiredIds = new Set(
    sources.filter((s) => isSuperseded(s) || rejected(s.content)).map((s) => s.id),
  );
  const live = new Set(
    sources.filter((s) => !retiredIds.has(s.id)).map((s) => duplicateKey(s.content)),
  );
  const gone = new Set(
    sources.filter((s) => retiredIds.has(s.id)).map((s) => duplicateKey(s.content)),
  );
  const retired = (text: string): boolean =>
    (gone.has(duplicateKey(text)) && !live.has(duplicateKey(text))) || rejected(text);
  return mergedSuccessor(row, retired, retiredIds);
}
