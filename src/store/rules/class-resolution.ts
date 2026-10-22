// A claim's prediction class, once for both adapters: the tenant's class tags scored by lower-cased token overlap.
import type { ClassResolution } from '../port/types.js';

/** A unique best of at least one shared token wins; a tie at the top resolves no class, since an alphabetical pick
 * would name the wrong class on an ambiguous claim. The result does not depend on the order of `classTags`. */
export function resolveClass(classTags: Iterable<string>, queryTokens: readonly string[]): ClassResolution {
  if (queryTokens.length === 0) return { classTag: null, tiebreak: false };
  const query = new Set(queryTokens);
  let best = 0;
  let second = 0;
  let bestClass: string | null = null;
  for (const tag of classTags) {
    const parts = tag
      .toLowerCase()
      .split(/[-_\s]+/)
      .filter((part) => part.length >= 3);
    const score = parts.filter((part) => query.has(part)).length;
    if (score > best) {
      second = best;
      best = score;
      bestClass = tag;
    } else if ((score === best && score > 0) || score > second) {
      second = score;
    }
  }
  if (best < 1) return { classTag: null, tiebreak: false };
  if (best === second) return { classTag: null, tiebreak: true };
  return { classTag: bestClass, tiebreak: false };
}
