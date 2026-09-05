/**
 * Deterministic tie-break comparators for recall ranking.
 *
 * A true LEAF module: imports NOTHING from any sort-site module (search.ts,
 * physics.ts, api.ts, cli.ts, shared.ts, goals.ts, graph-recall.ts,
 * multihop.ts, rerankers/*). Every comparator here takes a structural param
 * type instead of an imported one, on purpose — a type-only import back to
 * search.ts would still create the search.ts <-> physics.ts ESM import
 * cycle this module exists to avoid (r2 critic HIGH,
 * docs/plans/2026-07-09-recall-determinism.md T2).
 *
 * Mirrors the deliberate-determinism comment style already established in
 * graph-stream.ts:88, :165-168, :233-236 — a sort with a documented,
 * reproducible tiebreak instead of leaving ties to array/scan order.
 */

/** Minimal shape needed to break a tie deterministically across fresh
 *  ingests of the same content into different stores. The metadata keys are
 *  optional so existing `{ content, id }` callers (tests, benchmarks) still fit;
 *  a full MemoryEntry satisfies it structurally and gets the metadata order. */
export interface EntryIdentity {
  content: string;
  id: string;
  layer?: string;
  tags?: readonly string[];
  source?: string;
}

/**
 * content asc -> layer rank asc -> distinct tag count desc -> sorted tags asc
 * -> source asc -> id asc (all string compares are UTF-16 code-unit order).
 *
 * `content` is the cross-ingest-stable key: identical text ingested into two
 * independently-created stores (different directory name, different insert
 * order of everything else on disk) sorts identically. The metadata keys make
 * byte-identical twins order by what they carry instead of by `id`
 * (`crypto.randomUUID()`), which is per-instance random: before v1.38.1 the
 * dedupe survivor of two twins that differed only in tags or source was
 * whichever id sorted first, and a semantic/episodic pair always kept the
 * episodic copy because `mem_` sorts before `sem_`. `id` stays the terminal
 * key so the order is total within one store.
 *
 * Layer rank puts semantic first: semantic rows are consolidation output, so
 * keeping that copy preserves the promotion instead of demoting the memory.
 * Unknown or missing layers rank last and then compare as raw strings.
 * Tags prefer the copy with more distinct labels (fewer labels are lost on
 * dedupe); source is an arbitrary but stable key.
 *
 * Plain `<`/`>`, NOT `localeCompare`: `localeCompare` is locale- and
 * ICU-version-dependent (a determinism leak in its own right) and needlessly
 * slow for a tiebreak that only needs a total order. The metadata keys are
 * only computed on a content tie, which is rare post-T1 (path-tag embedding
 * fix), so the per-compare Set/sort cost never lands on the hot path.
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
  return ub.length - ua.length || compareStrings(ua.join('\0'), ub.join('\0'));
}

/** Minimal shape for score-primary sort sites (SearchResult and friends
 *  that carry `{ score, entry: { content, id } }`). */
export interface ScoredEntryLike {
  score: number;
  entry: EntryIdentity;
}

/**
 * score descending -> `compareEntryIdentity`. The shared ordering rule for
 * every score-primary recall sort site (search.ts, shared.ts, goals.ts,
 * api.ts, cli.ts, graph-recall.ts, multihop.ts, rerankers/cross-encoder.ts).
 * Sites delegate wholesale to this (via a thin arrow where the element
 * shape's score field is named something other than `score`, e.g.
 * `rerankScore`) rather than reimplementing `b.score - a.score` locally, so
 * the tiebreak can't silently drift between call sites.
 */
export function compareScoredResults(a: ScoredEntryLike, b: ScoredEntryLike): number {
  const d = b.score - a.score;
  return d !== 0 ? d : compareEntryIdentity(a.entry, b.entry);
}

/**
 * Build a score-desc -> tie-key comparator for the physics layer.
 *
 * `ScoredPhysicsResult` (physics.ts) carries `{ memoryId, baseScore,
 * clusterAmplification, finalScore }` -- NO `entry`/`content` in scope at
 * that layer, so `compareEntryIdentity` cannot apply directly (plan T2
 * shape (c)). With only the default memoryId key this is PER-INSTANCE-ONLY
 * determinism; callers that need CROSS-INGEST stability supply `tieKeyOf`
 * mapping the result to its memory CONTENT (codex review finding: the
 * baseScore tie order selects the cluster_top_k amplification set, which
 * MUTATES scores before the downstream content-aware merge sort runs -- so
 * the tie key must be content-stable at THIS layer, not just downstream).
 *
 * A factory (not a fixed-field comparator) because physics.ts re-sorts the
 * same result array by two different score fields in sequence (`baseScore`
 * for top-K selection, then `finalScore` after cluster amplification) — one
 * shared tiebreak rule, parameterised by which field is primary this pass.
 */
export function comparePhysicsResultsBy<T extends { memoryId: string }>(
  scoreOf: (r: T) => number,
  tieKeyOf?: (r: T) => string,
): (a: T, b: T) => number {
  return (a: T, b: T): number => {
    const d = scoreOf(b) - scoreOf(a);
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
