/**
 * Deterministic dedupe survivor selection
 * (docs/plans/2026-07-16-dedupe-survivor-determinism.md).
 *
 * Pins that `deduplicateStore` picks the SAME surviving content regardless
 * of ingest order: strength bucket desc -> retrieval_count desc ->
 * compareEntryIdentity (content asc -> layer -> tags -> source -> id asc;
 * cases 9-11 pin the metadata keys; 12-13 pin the candidate filter). Real-DB per project
 * convention (measure-ties-before-fixing / real-store-guard): each test
 * isolates a fresh hippoRoot via mkdtempSync + initStore, following the
 * tmpHome idiom in tests/api-sleep.test.ts.
 *
 * T2 (src/consolidate.ts mergeContents tie key) is exercised through the
 * public `consolidate()` merge pass (test 7), following the Merge-pass
 * idiom in tests/consolidate.test.ts -- `mergeContents` itself stays
 * file-private.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { remember, type Context } from '../src/api.js';
import { deduplicateStore, strengthBucket } from '../src/dedupe.js';
import { compareEntryIdentity } from '../src/compare.js';
import { consolidate } from '../src/consolidate.js';
import { createMemory, Layer } from '../src/memory.js';

function tmpHome(prefix: string) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  initStore(home);
  return {
    home,
    restore: () => rmSync(home, { recursive: true, force: true }),
  };
}

function ctxFor(home: string): Context {
  return { hippoRoot: home, tenantId: 'default', actor: { subject: 'test', role: 'admin' } };
}

function setStrength(home: string, id: string, strength: number): void {
  const db = openHippoDb(home);
  try {
    db.prepare(`UPDATE memories SET strength = ? WHERE id = ?`).run(strength, id);
  } finally {
    closeHippoDb(db);
  }
}

function setRetrievalCount(home: string, id: string, count: number): void {
  const db = openHippoDb(home);
  try {
    db.prepare(`UPDATE memories SET retrieval_count = ? WHERE id = ?`).run(count, id);
  } finally {
    closeHippoDb(db);
  }
}

function permutationsOf3(): number[][] {
  const items = [0, 1, 2];
  const out: number[][] = [];
  for (const a of items) {
    for (const b of items) {
      if (b === a) continue;
      for (const c of items) {
        if (c === a || c === b) continue;
        out.push([a, b, c]);
      }
    }
  }
  return out;
}

// Near-duplicate probe pair: 14 tokens per entry, 13 shared, one word swapped
// ("this" -> "last"). Jaccard = 13/15 = 0.8667 (> 0.7 dedupe threshold),
// computed against src/search.ts textOverlap's tokenizer (lowercase,
// punctuation-stripped, length>1 tokens, set-based Jaccard).
const CONTENT_A =
  'The quarterly finance report shows revenue grew steadily across all four regions this year';
const CONTENT_B =
  'The quarterly finance report shows revenue grew steadily across all four regions last year';

// Three mutually near-duplicate contents for the permutation test: a 20
// shared-token base sentence, each variant swapping a DIFFERENT single word
// for a word that appears nowhere else in the set. Any two variants share
// 18 of 20 tokens each (intersection 18, union 22) -> Jaccard 18/22 = 0.8182
// (> 0.7), so all three pairs are near-duplicates of each other.
const VARIANT_A =
  'our deployment pipeline automatically runs full suite of integration tests before every production release each week without exception this time';
const VARIANT_B =
  'the nightly pipeline automatically runs full suite of integration tests before every production release each week without exception this time';
const VARIANT_C =
  'the deployment pipeline automatically runs full suite of integration tests before every production release each week without exception last time';

describe('dedupe survivor determinism', () => {
  it('1. keeps the same surviving content across opposite ingest orders (red-on-master core)', () => {
    const s1 = tmpHome('hippo-dedupe-det-1a-');
    const s2 = tmpHome('hippo-dedupe-det-1b-');
    try {
      remember(ctxFor(s1.home), { content: CONTENT_A });
      remember(ctxFor(s1.home), { content: CONTENT_B });

      remember(ctxFor(s2.home), { content: CONTENT_B });
      remember(ctxFor(s2.home), { content: CONTENT_A });

      const result1 = deduplicateStore(s1.home);
      const result2 = deduplicateStore(s2.home);

      expect(result1.removed).toBe(1);
      expect(result2.removed).toBe(1);
      expect(result1.pairs[0].keptContent).toBe(result2.pairs[0].keptContent);
    } finally {
      s1.restore();
      s2.restore();
    }
  });

  it('2. permutation invariance: 3 pairwise near-duplicates with an epsilon-chain triple (1.0/0.994/0.988) survive identically across all 6 ingest orders', () => {
    const contents = [VARIANT_A, VARIANT_B, VARIANT_C];
    const strengths = [1.0, 0.994, 0.988]; // pins transitivity: old raw-epsilon check tied 1.0~0.994 and 0.994~0.988 but not 1.0~0.988
    const survivorContents = new Set<string>();

    for (const perm of permutationsOf3()) {
      const { home, restore } = tmpHome('hippo-dedupe-det-2-');
      try {
        const ids: string[] = [];
        for (const idx of perm) {
          const { id } = remember(ctxFor(home), { content: contents[idx] });
          ids[idx] = id;
        }
        for (let idx = 0; idx < contents.length; idx++) {
          setStrength(home, ids[idx], strengths[idx]);
        }

        deduplicateStore(home);
        const remaining = loadAllEntries(home, 'default');
        expect(remaining.length).toBe(1);
        survivorContents.add(remaining[0].content);
      } finally {
        restore();
      }
    }

    expect(survivorContents.size).toBe(1);
    expect([...survivorContents][0]).toBe(VARIANT_A);
  });

  it('3. strength dominance preserved: materially stronger entry survives even when ingested last', () => {
    const { home, restore } = tmpHome('hippo-dedupe-det-3-');
    try {
      const weak = remember(ctxFor(home), { content: CONTENT_A });
      const strong = remember(ctxFor(home), { content: CONTENT_B });
      setStrength(home, weak.id, 0.5);
      setStrength(home, strong.id, 1.0);

      const result = deduplicateStore(home);

      expect(result.removed).toBe(1);
      expect(result.pairs[0].kept).toBe(strong.id);
      expect(result.pairs[0].keptContent).toBe(CONTENT_B);
      expect(result.pairs[0].removed).toBe(weak.id);
    } finally {
      restore();
    }
  });

  it('4. retrieval-count tiebreak preserved on an equal strength bucket, regardless of ingest order', () => {
    const s1 = tmpHome('hippo-dedupe-det-4a-');
    const s2 = tmpHome('hippo-dedupe-det-4b-');
    try {
      // Order 1: low-retrieval entry ingested first.
      const low1 = remember(ctxFor(s1.home), { content: CONTENT_A });
      const high1 = remember(ctxFor(s1.home), { content: CONTENT_B });
      setStrength(s1.home, low1.id, 1.0);
      setStrength(s1.home, high1.id, 1.0);
      setRetrievalCount(s1.home, low1.id, 0);
      setRetrievalCount(s1.home, high1.id, 5);

      // Order 2: high-retrieval entry ingested first.
      const high2 = remember(ctxFor(s2.home), { content: CONTENT_B });
      const low2 = remember(ctxFor(s2.home), { content: CONTENT_A });
      setStrength(s2.home, high2.id, 1.0);
      setStrength(s2.home, low2.id, 1.0);
      setRetrievalCount(s2.home, high2.id, 5);
      setRetrievalCount(s2.home, low2.id, 0);

      const result1 = deduplicateStore(s1.home);
      const result2 = deduplicateStore(s2.home);

      expect(result1.pairs[0].keptContent).toBe(CONTENT_B);
      expect(result2.pairs[0].keptContent).toBe(CONTENT_B);
      expect(result1.pairs[0].kept).toBe(high1.id);
      expect(result2.pairs[0].kept).toBe(high2.id);
    } finally {
      s1.restore();
      s2.restore();
    }
  });

  it('4b. quantization intent: within-epsilon strength difference is a TIE, so retrieval_count decides (kills the raw-strength-compare mutant)', () => {
    // strengths 1.0 and 0.996 land in the SAME bucket (round(100.0) ==
    // round(99.6) == 100), so under the shipped comparator retrieval_count
    // decides -- the 0.996-strength / 5-retrieval entry must survive. A
    // raw-strength compare ((b.strength ?? 0) - (a.strength ?? 0)) would
    // keep the 1.0-strength entry instead and fail this test: this is the
    // one case that pins the bucket quantization itself, not just the
    // determinism properties (independent-review r1 MED).
    const { home, restore } = tmpHome('hippo-dedupe-det-4b-');
    try {
      const strongRaw = remember(ctxFor(home), { content: CONTENT_A });
      const retrieved = remember(ctxFor(home), { content: CONTENT_B });
      setStrength(home, strongRaw.id, 1.0);
      setStrength(home, retrieved.id, 0.996);
      setRetrievalCount(home, strongRaw.id, 0);
      setRetrievalCount(home, retrieved.id, 5);

      const result = deduplicateStore(home);

      expect(result.removed).toBe(1);
      expect(result.pairs[0].kept).toBe(retrieved.id);
      expect(result.pairs[0].keptContent).toBe(CONTENT_B);
      expect(result.pairs[0].removed).toBe(strongRaw.id);
    } finally {
      restore();
    }
  });

  it('5. exact-content duplicates: dedupe removes one, store ends with exactly one copy', () => {
    const { home, restore } = tmpHome('hippo-dedupe-det-5-');
    try {
      remember(ctxFor(home), { content: CONTENT_A });
      remember(ctxFor(home), { content: CONTENT_A });

      const result = deduplicateStore(home);

      expect(result.removed).toBe(1);
      const remaining = loadAllEntries(home, 'default');
      expect(remaining.length).toBe(1);
      expect(remaining[0].content).toBe(CONTENT_A);
    } finally {
      restore();
    }
  });

  it('6. dryRun parity: dryRun pairs equal what a subsequent real run deletes', () => {
    const { home, restore } = tmpHome('hippo-dedupe-det-6-');
    try {
      remember(ctxFor(home), { content: CONTENT_A });
      remember(ctxFor(home), { content: CONTENT_B });

      const dry = deduplicateStore(home, { dryRun: true });
      const real = deduplicateStore(home, { dryRun: false });

      expect(dry.removed).toBe(1);
      expect(real.removed).toBe(1);
      expect(dry.pairs.map((p) => p.removed)).toEqual(real.pairs.map((p) => p.removed));
      expect(dry.pairs.map((p) => p.removedContent)).toEqual(real.pairs.map((p) => p.removedContent));
      expect(dry.pairs.map((p) => p.keptContent)).toEqual(real.pairs.map((p) => p.keptContent));

      const remaining = loadAllEntries(home, 'default');
      expect(remaining.length).toBe(1);
      expect(remaining[0].content).toBe(real.pairs[0].keptContent);
    } finally {
      restore();
    }
  });

  it('7. mergeContents equal-length tie: merged base identical across opposite ingest orders (content asc tie key)', async () => {
    // Equal length (verified below), one same-length word swapped -->
    // Jaccard 5/7 = 0.714 > MERGE_OVERLAP_THRESHOLD (0.35), so the merge
    // pass fires and mergeContents' content.length primary key is a REAL
    // tie; only the compareEntryIdentity tie key decides the base. Same
    // `now` for both consolidate calls guards against decay flakiness.
    const contentAlpha = 'cache refresh failure data pipeline alpha';
    const contentOmega = 'cache refresh failure data pipeline omega';
    expect(contentAlpha.length).toBe(contentOmega.length);

    const now = new Date();
    const bases: string[] = [];

    for (const order of [[contentAlpha, contentOmega], [contentOmega, contentAlpha]]) {
      const { home, restore } = tmpHome('hippo-dedupe-det-7-');
      try {
        for (const content of order) {
          writeEntry(home, createMemory(content, { layer: Layer.Episodic }));
        }

        const result = await consolidate(home, { now });
        expect(result.merged).toBeGreaterThan(0);

        const semantics = loadAllEntries(home).filter(
          (e) => e.layer === Layer.Semantic && e.content.startsWith('[Consolidated from 2 related memories]'),
        );
        expect(semantics.length).toBe(1);
        // Content shape: '[Consolidated from 2 related memories]\n\n<base>'.
        bases.push(semantics[0].content.split('\n\n')[1]);
      } finally {
        restore();
      }
    }

    expect(bases[0]).toBe(bases[1]);
    // content asc tie key: the lexicographically smaller content is the base.
    expect(bases[0]).toBe(contentAlpha);
  });

  it('8. strengthBucket maps non-finite strength to bucket 0 and the assembled comparator chain never returns NaN', () => {
    expect(strengthBucket(NaN)).toBe(0);
    expect(strengthBucket(Infinity)).toBe(0);
    expect(strengthBucket(-Infinity)).toBe(0);
    expect(strengthBucket(null)).toBe(0);
    expect(strengthBucket(undefined)).toBe(0);
    expect(strengthBucket(0)).toBe(0);
    expect(strengthBucket(1)).toBe(100);

    // Mirrors dedupe.ts's comparator chain (bucket desc -> retrieval desc ->
    // compareEntryIdentity) using the same two exported building blocks, to
    // pin that a NaN-strength entry still yields a strict, non-NaN order --
    // no DB needed, pure-function test only.
    const a = { id: 'aaa-nan', content: 'alpha content', strength: NaN, retrieval_count: 0 };
    const b = { id: 'bbb-normal', content: 'beta content', strength: 0.5, retrieval_count: 0 };

    const bucketDiff = strengthBucket(b.strength) - strengthBucket(a.strength);
    expect(Number.isNaN(bucketDiff)).toBe(false);

    const retrievalDiff = (b.retrieval_count ?? 0) - (a.retrieval_count ?? 0);
    expect(Number.isNaN(retrievalDiff)).toBe(false);

    const identity = compareEntryIdentity(a, b);
    expect(Number.isNaN(identity)).toBe(false);

    const cmp = bucketDiff !== 0 ? bucketDiff : retrievalDiff !== 0 ? retrievalDiff : identity;
    expect(Number.isNaN(cmp)).toBe(false);
    expect(Number.isFinite(cmp)).toBe(true);
  });

  // Cases 9-11: byte-identical twins tie on strength, retrieval_count and
  // content, so only the metadata keys can decide the survivor. Four twins
  // (not two) so a pass under the old id-random comparator needs 1/4 luck.
  const TWIN_TEXT = 'byte identical twin content for the survivor metadata cases';

  function survivorAfterDedupe(order: ReturnType<typeof createMemory>[]) {
    const { home, restore } = tmpHome('hippo-dedupe-det-meta-');
    try {
      for (const entry of order) writeEntry(home, entry);
      const result = deduplicateStore(home);
      expect(result.removed).toBe(order.length - 1);
      const remaining = loadAllEntries(home);
      expect(remaining.length).toBe(1);
      return { survivor: remaining[0], pairs: result.pairs };
    } finally {
      restore();
    }
  }

  it('9. twins differing only in tags keep the copy with the most tags in both ingest orders', () => {
    const twins = [['a'], ['b'], ['c'], ['d', 'e']].map((tags) => createMemory(TWIN_TEXT, { tags }));
    const forward = survivorAfterDedupe(twins).survivor;
    const reversed = survivorAfterDedupe([...twins].reverse()).survivor;
    expect([...forward.tags].sort()).toEqual(['d', 'e']);
    expect([...reversed.tags].sort()).toEqual(['d', 'e']);
  });

  it('10. twins differing only in source keep the lowest source in both ingest orders', () => {
    const twins = ['src-c', 'src-a', 'src-d', 'src-b'].map((source) => createMemory(TWIN_TEXT, { source }));
    expect(survivorAfterDedupe(twins).survivor.source).toBe('src-a');
    expect(survivorAfterDedupe([...twins].reverse()).survivor.source).toBe('src-a');
  });

  it('11. episodic/semantic twins keep the semantic copy in both ingest orders (was the episodic one via the mem_/sem_ id prefix)', () => {
    const episodic = createMemory(TWIN_TEXT, { layer: Layer.Episodic });
    const semantic = createMemory(TWIN_TEXT, { layer: Layer.Semantic });
    for (const order of [[episodic, semantic], [semantic, episodic]]) {
      const { survivor, pairs } = survivorAfterDedupe(order);
      expect(survivor.layer).toBe(Layer.Semantic);
      expect(pairs).toHaveLength(1);
      expect(pairs[0].keptLayer).toBe(Layer.Semantic);
      expect(pairs[0].removedLayer).toBe(Layer.Episodic);
    }
  });

  // Cases 12-13 (codex round 1): the layer rank made these two lifecycle
  // states deterministic LOSERS, so dedupe must not consider them at all.
  it('12. a raw (append-only) episodic twin is not a dedupe candidate, so sleep no longer aborts on the delete trigger', () => {
    const raw = createMemory(TWIN_TEXT, { layer: Layer.Episodic, kind: 'raw' });
    const semantic = createMemory(TWIN_TEXT, { layer: Layer.Semantic });
    for (const order of [[raw, semantic], [semantic, raw]]) {
      const { home, restore } = tmpHome('hippo-dedupe-det-raw-');
      try {
        for (const entry of order) writeEntry(home, entry);
        const result = deduplicateStore(home);
        expect(result.removed).toBe(0);
        expect(result.pairs).toHaveLength(0);
        const ids = loadAllEntries(home).map((e) => e.id).sort();
        expect(ids).toEqual([raw.id, semantic.id].sort());
      } finally {
        restore();
      }
    }
  });

  it('13. a superseded semantic twin never outranks the current episodic re-ingest', () => {
    const { home, restore } = tmpHome('hippo-dedupe-det-superseded-');
    try {
      const successor = createMemory('unrelated successor text that replaced the old semantic row', { layer: Layer.Semantic });
      const stale = {
        ...createMemory(TWIN_TEXT, { layer: Layer.Semantic }),
        superseded_by: successor.id,
        kind: 'superseded' as const,
      };
      const current = createMemory(TWIN_TEXT, { layer: Layer.Episodic });
      for (const entry of [successor, stale, current]) writeEntry(home, entry);
      const result = deduplicateStore(home);
      expect(result.removed).toBe(0);
      expect(result.pairs).toHaveLength(0);
      const ids = loadAllEntries(home).map((e) => e.id).sort();
      expect(ids).toEqual([successor.id, stale.id, current.id].sort());
    } finally {
      restore();
    }
  });
});
