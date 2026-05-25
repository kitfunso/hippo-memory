/**
 * v0.28 — pure helper for computing shared-tag pairs between memories.
 *
 * Pulled out of BrainScene so it can be tested without WebGL stubs.
 *
 * Algorithm (plan v3 S3, plan-eng-critic R2 tiered cap):
 *
 *   1. Build a tag → memory-id index, optionally filtered by excludePrefix
 *      (we always exclude `path:*` because project-namespace tags are too
 *      broad to be a useful similarity signal).
 *
 *   2. Walk tags in ASCENDING user-count order, so the running "current
 *      intersection" tally is built from smaller (always-enumerated) tags
 *      BEFORE the medium-band 50-300 tags need to pick their top-K.
 *      (plan-eng-critic R2 LOW on perTagTopK ordering rule.)
 *
 *   3. For each tag:
 *      - userCount < softCap (default 50): enumerate ALL pairs into the
 *        pair-count map (most tags fall here on the live fixture).
 *      - softCap <= userCount < hardCap (default 50-300): build a temp
 *        list of all pairs for THIS tag with their current cumulative
 *        intersection score, sort by score DESC, emit top-K=15.
 *      - userCount >= hardCap (300+): skip the tag entirely (would
 *        produce O(N²) pairs that drown out genuine clusters).
 *
 *   4. Filter the pair-count map by minShared (default 2) and return as
 *      an array sorted by count DESC, then a-id ASC for deterministic
 *      iteration (the consumer relies on this ordering for the
 *      HARD_EDGE_CAP=2000 break to preserve strongest pairs).
 *
 * Performance budget: <50ms on a 500-memory fixture (AC7, enforced in
 * sharedTagPairs.test.ts via performance.now()).
 */

import type { Memory } from "../types.js";

export interface SharedTagPair {
  /** Two memory IDs in deterministic order: a < b lexicographically. */
  a: string;
  b: string;
  /** How many qualifying tags both memories carry. >=2 by construction. */
  count: number;
}

export interface PairsOpts {
  /** Tag-prefix to exclude before any tier check (e.g. "path:" for the
   * too-broad project-namespace tags). Default: undefined (no exclusion). */
  excludePrefix?: string;
  /** Tags with userCount < softCap enumerate all pairs. Default: 50. */
  softCap?: number;
  /** Tags with userCount >= hardCap are fully skipped. Default: 300. */
  hardCap?: number;
  /** For tags in [softCap, hardCap), emit only top-K pairs by current
   * cumulative intersection. Default: 15. */
  perTagTopK?: number;
  /** Minimum shared-tag count to emit a pair in the final output.
   * Default: 2 (single-shared-tag pairs are too weak a signal). */
  minShared?: number;
}

const DEFAULT_OPTS = {
  softCap: 50,
  hardCap: 300,
  perTagTopK: 15,
  minShared: 2,
} as const;

/** Deterministic key for an unordered pair: a < b lexicographically. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Compute shared-tag pairs across a set of memories. Pure + deterministic;
 * same input → same output across calls and sessions.
 */
export function computeSharedTagPairs(
  memories: readonly Memory[],
  opts: PairsOpts = {},
): SharedTagPair[] {
  const softCap = opts.softCap ?? DEFAULT_OPTS.softCap;
  const hardCap = opts.hardCap ?? DEFAULT_OPTS.hardCap;
  const perTagTopK = opts.perTagTopK ?? DEFAULT_OPTS.perTagTopK;
  const minShared = opts.minShared ?? DEFAULT_OPTS.minShared;
  const excludePrefix = opts.excludePrefix;

  // Step 1: build tag → memory-id index, applying excludePrefix.
  const tagIndex = new Map<string, string[]>();
  for (const mem of memories) {
    for (const tag of mem.tags) {
      if (excludePrefix !== undefined && tag.startsWith(excludePrefix)) continue;
      let users = tagIndex.get(tag);
      if (users === undefined) {
        users = [];
        tagIndex.set(tag, users);
      }
      users.push(mem.id);
    }
  }

  // Step 2: process tags in ASCENDING user-count order so the running
  // intersection tally is built from smaller tags first (the perTagTopK
  // selection for medium-band tags then sees a meaningful score).
  const orderedTags = [...tagIndex.entries()].sort((a, b) => a[1].length - b[1].length);

  // Step 3: walk tags by tier; accumulate counts into pairCounts.
  const pairCounts = new Map<string, number>();

  for (const [, users] of orderedTags) {
    if (users.length < 2) continue;
    if (users.length >= hardCap) continue;

    if (users.length < softCap) {
      // Enumerate all C(N,2) pairs.
      for (let i = 0; i < users.length; i++) {
        for (let j = i + 1; j < users.length; j++) {
          const key = pairKey(users[i]!, users[j]!);
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
      }
    } else {
      // Medium-band tag: build all candidate pairs for this tag with their
      // CURRENT cumulative intersection score (built from smaller-tag
      // contributions already processed), then keep only top-K by score.
      const candidates: Array<{ key: string; current: number }> = [];
      for (let i = 0; i < users.length; i++) {
        for (let j = i + 1; j < users.length; j++) {
          const key = pairKey(users[i]!, users[j]!);
          candidates.push({ key, current: pairCounts.get(key) ?? 0 });
        }
      }
      candidates.sort((a, b) => b.current - a.current || a.key.localeCompare(b.key));
      const top = candidates.slice(0, perTagTopK);
      for (const { key } of top) {
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Step 4: filter by minShared, sort deterministically, return as array.
  const out: SharedTagPair[] = [];
  for (const [key, count] of pairCounts) {
    if (count < minShared) continue;
    const idx = key.indexOf('|');
    const a = key.slice(0, idx);
    const b = key.slice(idx + 1);
    out.push({ a, b, count });
  }
  out.sort((x, y) => y.count - x.count || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return out;
}
