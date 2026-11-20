// How a LIKE search reaches each term, set once so every store that searches by substring splits
// its terms the same way.

// A trigram holds 3 characters, so FTS5 cannot look up a shorter term.
const MIN_TRIGRAM_CHARS = 3;

/** `terms` split by the way a substring search reaches them: with `indexed`, a term of 3 or more
 * code points goes to the trigram index; every other term is tested on the newest rows. */
export function splitLikeTerms(terms: readonly string[], indexed: boolean) {
  const viaIndex: string[] = [];
  const windowed: string[] = [];
  for (const term of terms) {
    (indexed && [...term].length >= MIN_TRIGRAM_CHARS ? viaIndex : windowed).push(term);
  }
  return { indexed: viaIndex, windowed };
}
