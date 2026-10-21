// hippo.db's memories_fts as this adapter reads it: each row's unicode61 tokens in the content and tags columns, and
// FTS5's own bm25 over them, so whole-word recall ranks and scores its matches as hippo.db does.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { naturalLog } from './natural-log.js';

/** FTS5's unicode61 tokens: runs of letters and digits, case folded, diacritics removed. */
export const ftsTokens = (text: string): string[] =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

interface FtsRow {
  readonly content: readonly string[];
  readonly tags: readonly string[];
}

// A write replaces the entry object, so a row cached by its entry stays true.
const indexed = new WeakMap<MemoryEntry, FtsRow>();

function ftsRowOf(entry: MemoryEntry): FtsRow {
  const held = indexed.get(entry);
  if (held) return held;
  const row = { content: ftsTokens(entry.content), tags: ftsTokens(entry.tags.join(' ')) };
  indexed.set(entry, row);
  return row;
}

/** The distinct tokens of the row's indexed columns, as fts5vocab counts a document once per term. */
export const rowTerms = (entry: MemoryEntry): Set<string> => {
  const row = ftsRowOf(entry);
  return new Set([...row.content, ...row.tags]);
};

/** Places the phrase's tokens appear one after another in one column, as FTS5's xInst lists them. */
function instancesIn(tokens: readonly string[], phrase: readonly string[]): number {
  if (phrase.length === 0) return 0;
  let found = 0;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((part, j) => tokens[i + j] === part)) found += 1;
  }
  return found;
}

const instances = (row: FtsRow, phrase: readonly string[]): number =>
  instancesIn(row.content, phrase) + instancesIn(row.tags, phrase);

/** As an FTS5 `content : "phrase"` query: the content column holds the phrase's tokens one after another. */
export const contentHoldsPhrase = (entry: MemoryEntry, phrase: string): boolean =>
  instancesIn(ftsRowOf(entry).content, ftsTokens(phrase)) > 0;

const K1 = 1.2;
const B = 0.75;

export interface FtsMatch {
  readonly entry: MemoryEntry;
  /** FTS5's bm25(): negative, lower is better. */
  readonly bm25: number;
}

/** The `candidates` an OR of the `terms` phrases matches, scored by FTS5's bm25 over every row in `table`. */
export function ftsMatches(
  table: Iterable<MemoryEntry>,
  candidates: readonly MemoryEntry[],
  terms: readonly string[],
): FtsMatch[] {
  const phrases = terms.map(ftsTokens);
  const rows = [...table].map(ftsRowOf);
  const avgdl = rows.reduce((sum, row) => sum + row.content.length + row.tags.length, 0) / rows.length;
  // FTS5 floors a phrase in half the rows or more at 1e-6, so a common term still adds to the score.
  const idf = phrases.map((phrase) => {
    const hits = rows.filter((row) => instances(row, phrase) > 0).length;
    const value = naturalLog((rows.length - hits + 0.5) / (hits + 0.5));
    return value <= 0 ? 1e-6 : value;
  });
  return candidates.flatMap((entry) => {
    const row = ftsRowOf(entry);
    const freq = phrases.map((phrase) => instances(row, phrase));
    if (freq.every((f) => f === 0)) return [];
    const size = row.content.length + row.tags.length;
    let score = 0;
    freq.forEach((f, i) => {
      score += (idf[i] ?? 0) * ((f * (K1 + 1.0)) / (f + K1 * (1 - B + (B * size) / avgdl)));
    });
    return [{ entry, bm25: -1.0 * score }];
  });
}
