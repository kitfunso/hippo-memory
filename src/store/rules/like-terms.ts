const MIN_TRIGRAM_CHARS = 3;

/** `terms` split by the way a substring search reaches them: with `hasTrigramIndex`, a term of 3 or more
 * code points goes to the trigram index; every other term is tested on the newest rows. */
export function splitLikeTerms(terms: readonly string[], hasTrigramIndex: boolean) {
  const viaIndex: string[] = [];
  const windowed: string[] = [];
  for (const term of terms) {
    (hasTrigramIndex && [...term].length >= MIN_TRIGRAM_CHARS ? viaIndex : windowed).push(term);
  }
  return { indexed: viaIndex, windowed };
}
