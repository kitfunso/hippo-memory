// Schema fit: how well a new memory's tags and words match what a set of memories already holds.

/** What schema fit reads from a set of memories, so a store can answer without loading its rows. */
export interface SchemaFitSource {
  readonly rows: number;
  /** How many times each tag appears across the set. */
  readonly tagCounts: ReadonlyMap<string, number>;
  /** Each memory's text; the walk stops once more matches cannot move the score. */
  readonly contents: Iterable<string>;
}

function significantTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((t) => t.length > 3));
}

/** The 0..1 fit of `content` and `tags` against `source`; computeSchemaFit in memory.ts documents the scale. */
export function schemaFitFrom(content: string, tags: readonly string[], source: SchemaFitSource): number {
  const N = source.rows;
  if (N === 0) return 0.5; // no schema yet, neutral
  const tagFreq = source.tagCounts;
  if (tags.length === 0 && tagFreq.size === 0) return 0.5;

  // Tag overlap, weighted so a shared rare tag counts for more than a shared common one.
  let weightedOverlap = 0;
  let totalWeight = 0;
  const maxIdf = Math.log(N + 1) + 1;
  for (const tag of tags) {
    const freq = tagFreq.get(tag) ?? 0;
    if (freq > 0) weightedOverlap += Math.log(N / freq) + 1;
    totalWeight += maxIdf;
  }
  // Scaled so that matching half the tags at average weight gives about 0.5.
  const tagScore = totalWeight > 0 ? Math.min(1, (weightedOverlap / totalWeight) * 2) : 0;

  const newTokens = significantTokens(content);
  if (newTokens.size === 0) return Math.min(1, Math.max(0, tagScore));

  // The content score is capped at 1, which this many matching memories reach.
  const enough = Math.max(5, N * 0.1);
  let contentMatches = 0;
  for (const text of source.contents) {
    const entryTokens = significantTokens(text);
    let shared = 0;
    for (const token of newTokens) {
      if (entryTokens.has(token)) shared++;
    }
    if (shared / newTokens.size > 0.2 && ++contentMatches >= enough) break;
  }
  const contentScore = Math.min(1, contentMatches / enough);

  const fit = 0.6 * tagScore + 0.4 * contentScore;
  return Math.min(1, Math.max(0, fit));
}
