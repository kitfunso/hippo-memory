/** Deterministic tie-break comparators for recall ranking. A true LEAF module: it imports from no sort-site module (search, physics, api, cli, goals,
 * graph-recall, multihop, rerankers), taking structural param types instead, because even a type-only import back would recreate the search <-> physics ESM
 * cycle this module exists to avoid. */

/** Minimal shape for a deterministic tie-break across fresh ingests into different stores;
 *  the metadata keys are optional so `{ content, id }` callers still fit. */
export interface EntryIdentity {
  content: string;
  id: string;
  layer?: string;
  tags?: readonly string[];
  source?: string;
}

/** Order: content, layer rank (semantic first, keeping the promotion), tag count desc, sorted tags, source, id; plain `<`/`>`, never `localeCompare`.
 * `content` is the cross-ingest-stable key; `id` is random per instance, so it is only the terminal key. Metadata keys are computed only on a content tie. */
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

/** Minimal shape for score-primary sort sites (SearchResult and friends
 *  that carry `{ score, entry: { content, id } }`). */
export interface ScoredEntryLike {
  score: number;
  entry: EntryIdentity;
}

/** score descending, then `compareEntryIdentity`: the shared ordering for every score-primary recall sort site, which delegate here (via an arrow when the
 * score field is not named `score`) so the tiebreak cannot drift between call sites. */
export function compareScoredResults(a: ScoredEntryLike, b: ScoredEntryLike): number {
  return compareScoresDesc(a.score, b.score) || compareEntryIdentity(a.entry, b.entry);
}

/** Larger first, NaN after every number, 0 for equal scores. Not a subtraction: two infinities, or any NaN, subtract to NaN, which a sort reads as a tie. */
export function compareScoresDesc(a: number, b: number): number {
  if (a > b) return -1;
  if (a < b) return 1;
  return Number(Number.isNaN(a)) - Number(Number.isNaN(b));
}

/** Score-desc then tie-key comparator for the physics layer (no `entry`/`content` in scope): the default memoryId key is per-instance determinism only.
 * Cross-ingest stability needs `tieKeyOf` (content), since the baseScore tie order picks the cluster_top_k set. A factory, as two fields sort in turn. */
export function comparePhysicsResultsBy<T extends { memoryId: string }>(
  scoreOf: (r: T) => number,
  tieKeyOf?: (r: T) => string,
): (a: T, b: T) => number {
  return (a: T, b: T): number => {
    const d = compareScoresDesc(scoreOf(a), scoreOf(b));
    if (d !== 0) return d;
    const ai = tieKeyOf ? tieKeyOf(a) : a.memoryId;
    const bi = tieKeyOf ? tieKeyOf(b) : b.memoryId;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    // Tie-key collision (e.g. duplicate content): fall through to memoryId
    // so the comparator still yields a total order within one store.
    return a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0;
  };
}
