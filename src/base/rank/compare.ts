/**
 * Deterministic tie-break comparators for recall ranking. A leaf module: it imports from no
 * sort-site module (search, api, cli, goals, graph-recall, multihop, rerankers) and takes
 * structural param types instead, so every sort site can import it without an ESM cycle. */

/** Minimal shape for a deterministic tie-break across fresh ingests into different stores; the metadata keys are
 *  optional so `{ content, id }` callers still fit. */
export interface EntryIdentity {
  content: string;
  id: string;
  layer?: string;
  tags?: readonly string[];
  source?: string;
}

/**
 * Order: content, layer rank (semantic first, keeping the promotion), tag count desc, sorted tags,
 * source, id; plain `<`/`>`, never `localeCompare`. `content` is the cross-ingest-stable key; `id`
 * is random per instance, so it is only the terminal key. Metadata keys are computed only on a
 * content tie.
 */
export function compareEntryIdentity(a: EntryIdentity, b: EntryIdentity): number {
  return (
    compareStrings(a.content, b.content) ||
    layerRank(a.layer) - layerRank(b.layer) ||
    compareStrings(a.layer ?? '', b.layer ?? '') ||
    compareTags(a.tags, b.tags) ||
    compareStrings(a.source ?? '', b.source ?? '') ||
    compareStrings(a.id, b.id)
  );
}

const LAYER_RANK: ReadonlyMap<string, number> = new Map([
  ['semantic', 0],
  ['episodic', 1],
  ['trace', 2],
  ['buffer', 3],
]);

function layerRank(layer: string | undefined): number {
  return LAYER_RANK.get(layer ?? '') ?? LAYER_RANK.size;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTags(a: readonly string[] | undefined, b: readonly string[] | undefined): number {
  const ua = [...new Set(a ?? [])].sort();
  const ub = [...new Set(b ?? [])].sort();
  if (ua.length !== ub.length) return ub.length - ua.length;
  // element-wise, not a joined string: a separator inside a tag would collide
  for (let i = 0; i < ua.length; i++) {
    const c = compareStrings(ua[i], ub[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** Minimal shape for score-primary sort sites (SearchResult and friends that carry `{ score, entry: { content, id }
 *  }`). */
export interface ScoredEntryLike {
  score: number;
  entry: EntryIdentity;
}

/**
 * score descending, then `compareEntryIdentity`: the shared ordering for every score-primary
 * recall sort site, which delegate here (via an arrow when the score field is not named `score`)
 * so the tiebreak cannot drift between call sites. */
export function compareScoredResults(a: ScoredEntryLike, b: ScoredEntryLike): number {
  return compareScoresDesc(a.score, b.score) || compareEntryIdentity(a.entry, b.entry);
}

/**
 * Larger first, NaN after every number, 0 for equal scores. Not a subtraction: two infinities, or
 * any NaN, subtract to NaN, which a sort reads as a tie.
 */
export function compareScoresDesc(a: number, b: number): number {
  if (a > b) return -1;
  if (a < b) return 1;
  return Number(Number.isNaN(a)) - Number(Number.isNaN(b));
}
