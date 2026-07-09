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
 *  ingests of the same content into different stores. */
export interface EntryIdentity {
  content: string;
  id: string;
}

/**
 * content ascending (UTF-16 code-unit compare) -> id ascending.
 *
 * `content` is the cross-ingest-stable key: identical text ingested into two
 * independently-created stores (different directory name, different insert
 * order of everything else on disk) sorts identically. `id`
 * (`crypto.randomUUID()`) is per-instance only — two stores ingesting the
 * same content never produce the same id, so it is a last-resort tiebreak
 * for genuine duplicate-content rows within one comparison, not a
 * cross-ingest-stable key on its own.
 *
 * Plain `<`/`>` (UTF-16 code-unit order), NOT `localeCompare`:
 * `localeCompare` is locale- and ICU-version-dependent (a determinism leak
 * in its own right) and is needlessly slow for a tiebreak that only needs a
 * total order, not a linguistically "correct" one. Full-content compare is O(len) worst case;
 * fine because ties are rare post-T1 (path-tag embedding fix) — no hashing
 * needed.
 */
export function compareEntryIdentity(a: EntryIdentity, b: EntryIdentity): number {
  if (a.content < b.content) return -1;
  if (a.content > b.content) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
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
