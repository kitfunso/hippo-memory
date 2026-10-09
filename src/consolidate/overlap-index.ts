// All-pairs overlap join through an inverted index over rare-first token prefixes (prefix filtering, Chaudhuri et al. 2006).

/** Smallest number of shared tokens any qualifying pair can have, given either side's token count. */
export type MinShared = (size: number) => number;

/** Shared >= threshold * union >= threshold * size; one token of slack covers float rounding in the caller's Jaccard check. */
export function jaccardMinShared(threshold: number, atLeast = 1): MinShared {
  return (size) => Math.max(atLeast, Math.ceil(threshold * size) - 1);
}

/** Maps i to each j > i, ascending, that may share `minShared` tokens with set i; a superset the caller checks exactly, never a pair sharing no token. */
export function overlapPartners(sets: readonly ReadonlySet<string>[], minShared: MinShared): (i: number) => number[] {
  const docFreq = new Map<string, number>();
  for (const set of sets) for (const t of set) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const rareFirst = (a: string, b: string): number => ((docFreq.get(a) ?? 0) - (docFreq.get(b) ?? 0)) || (a < b ? -1 : a > b ? 1 : 0);

  // Under one total order the first token two sets share lies in both sets' first size - minShared + 1 tokens.
  const prefixes = sets.map((set) => {
    const keep = set.size - Math.max(1, minShared(set.size)) + 1;
    return keep > 0 ? [...set].sort(rareFirst).slice(0, keep) : [];
  });
  const postings = new Map<string, number[]>();
  prefixes.forEach((prefix, i) => {
    for (const t of prefix) {
      const list = postings.get(t);
      if (list) list.push(i);
      else postings.set(t, [i]);
    }
  });

  return (i) => {
    const found = new Set<number>();
    for (const t of prefixes[i]) {
      const list = postings.get(t) ?? [];
      for (let k = list.length - 1; k >= 0 && list[k] > i; k--) found.add(list[k]);
    }
    return [...found].sort((a, b) => a - b);
  };
}
