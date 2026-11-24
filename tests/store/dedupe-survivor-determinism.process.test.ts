import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { remember } from '../../src/api/index.js';
import { deduplicateStore, strengthTieKey } from '../../src/domain/consolidate/dedupe.js';
import { compareEntryIdentity } from '../../src/base/rank/compare.js';
import { consolidate } from '../../src/index.js';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, sqliteStore, apiCtx } = sessionPerTest();

function ctxFor(home: string): FullContext {
  return apiCtx(home, 'default', { subject: 'test', role: 'admin' });
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

const CONTENT_A = 'The quarterly finance report shows revenue grew steadily across all four regions this year';
const CONTENT_B = CONTENT_A.replace(' this year', '  this year');

const VARIANT_B =
  'our deployment pipeline automatically runs full suite of integration tests before every production release each week without exception this time';
const VARIANT_A = VARIANT_B.replace(' this time', '  this time');
const VARIANT_C = VARIANT_B.replace(' each week', '  each week');

describe('dedupe survivor determinism', () => {
  it('1. keeps the same surviving content across opposite ingest orders (red-on-master core)', async () => {
    const s1 = makeRoot('dedupe-det-1a');
    const s2 = makeRoot('dedupe-det-1b');
    await remember(ctxFor(s1), { content: CONTENT_A });
    await remember(ctxFor(s1), { content: CONTENT_B });

    await remember(ctxFor(s2), { content: CONTENT_B });
    await remember(ctxFor(s2), { content: CONTENT_A });

    const result1 = await deduplicateStore(sqliteStore(s1));
    const result2 = await deduplicateStore(sqliteStore(s2));

    expect(result1.removed).toBe(1);
    expect(result2.removed).toBe(1);
    expect(result1.pairs[0].keptContent).toBe(result2.pairs[0].keptContent);
  });

  it('2. permutation invariance: 3 pairwise near-duplicates with an epsilon-chain triple (1.0/0.994/0.988) survive identically across all 6 ingest orders', async () => {
    const contents = [VARIANT_A, VARIANT_B, VARIANT_C];
    const strengths = [1.0, 0.994, 0.988];
    const survivorContents = new Set<string>();

    for (const perm of permutationsOf3()) {
      const home = makeRoot('dedupe-det-2');
      const ids: string[] = [];
      for (const idx of perm) {
        const { id } = await remember(ctxFor(home), { content: contents[idx] });
        ids[idx] = id;
      }
      for (let idx = 0; idx < contents.length; idx++) {
        setStrength(home, ids[idx], strengths[idx]);
      }

      await deduplicateStore(sqliteStore(home));
      const remaining = loadAllEntries(home, 'default');
      expect(remaining.length).toBe(1);
      survivorContents.add(remaining[0].content);
    }

    expect(survivorContents.size).toBe(1);
    expect([...survivorContents][0]).toBe(VARIANT_A);
  });

  it('3. strength dominance preserved: materially stronger entry survives even when ingested last', async () => {
    const home = makeRoot('dedupe-det-3');
    const weak = await remember(ctxFor(home), { content: CONTENT_A });
    const strong = await remember(ctxFor(home), { content: CONTENT_B });
    setStrength(home, weak.id, 0.5);
    setStrength(home, strong.id, 1.0);

    const result = await deduplicateStore(sqliteStore(home));

    expect(result.removed).toBe(1);
    expect(result.pairs[0].kept).toBe(strong.id);
    expect(result.pairs[0].keptContent).toBe(CONTENT_B);
    expect(result.pairs[0].removed).toBe(weak.id);
  });

  it('4. retrieval-count tiebreak preserved on an equal strength bucket, regardless of ingest order', async () => {
    const s1 = makeRoot('dedupe-det-4a');
    const s2 = makeRoot('dedupe-det-4b');
    const low1 = await remember(ctxFor(s1), { content: CONTENT_A });
    const high1 = await remember(ctxFor(s1), { content: CONTENT_B });
    setStrength(s1, low1.id, 1.0);
    setStrength(s1, high1.id, 1.0);
    setRetrievalCount(s1, low1.id, 0);
    setRetrievalCount(s1, high1.id, 5);

    const high2 = await remember(ctxFor(s2), { content: CONTENT_B });
    const low2 = await remember(ctxFor(s2), { content: CONTENT_A });
    setStrength(s2, high2.id, 1.0);
    setStrength(s2, low2.id, 1.0);
    setRetrievalCount(s2, high2.id, 5);
    setRetrievalCount(s2, low2.id, 0);

    const result1 = await deduplicateStore(sqliteStore(s1));
    const result2 = await deduplicateStore(sqliteStore(s2));

    expect(result1.pairs[0].keptContent).toBe(CONTENT_B);
    expect(result2.pairs[0].keptContent).toBe(CONTENT_B);
    expect(result1.pairs[0].kept).toBe(high1.id);
    expect(result2.pairs[0].kept).toBe(high2.id);
  });

  it('4b. quantization intent: within-epsilon strength difference is a TIE, so retrieval_count decides (kills the raw-strength-compare mutant)', async () => {
    const home = makeRoot('dedupe-det-4b');
    const strongRaw = await remember(ctxFor(home), { content: CONTENT_A });
    const retrieved = await remember(ctxFor(home), { content: CONTENT_B });
    setStrength(home, strongRaw.id, 1.0);
    setStrength(home, retrieved.id, 0.996);
    setRetrievalCount(home, strongRaw.id, 0);
    setRetrievalCount(home, retrieved.id, 5);

    const result = await deduplicateStore(sqliteStore(home));

    expect(result.removed).toBe(1);
    expect(result.pairs[0].kept).toBe(retrieved.id);
    expect(result.pairs[0].keptContent).toBe(CONTENT_B);
    expect(result.pairs[0].removed).toBe(strongRaw.id);
  });

  it('5. exact-content duplicates: dedupe removes one, store ends with exactly one copy', async () => {
    const home = makeRoot('dedupe-det-5');
    await remember(ctxFor(home), { content: CONTENT_A });
    await remember(ctxFor(home), { content: CONTENT_A });

    const result = await deduplicateStore(sqliteStore(home));

    expect(result.removed).toBe(1);
    const remaining = loadAllEntries(home, 'default');
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe(CONTENT_A);
  });

  it('6. dryRun parity: dryRun pairs equal what a subsequent real run deletes', async () => {
    const home = makeRoot('dedupe-det-6');
    await remember(ctxFor(home), { content: CONTENT_A });
    await remember(ctxFor(home), { content: CONTENT_B });

    const dry = await deduplicateStore(sqliteStore(home), { dryRun: true });
    const real = await deduplicateStore(sqliteStore(home), { dryRun: false });

    expect(dry.removed).toBe(1);
    expect(real.removed).toBe(1);
    expect(dry.pairs.map((p) => p.removed)).toEqual(real.pairs.map((p) => p.removed));
    expect(dry.pairs.map((p) => p.removedContent)).toEqual(real.pairs.map((p) => p.removedContent));
    expect(dry.pairs.map((p) => p.keptContent)).toEqual(real.pairs.map((p) => p.keptContent));

    const remaining = loadAllEntries(home, 'default');
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe(real.pairs[0].keptContent);
  });

  it('7. mergeContents same-created tie: merged base identical across opposite ingest orders (content asc tie key)', async () => {
    const contentAlpha = 'cache refresh failure data pipeline alpha';
    const contentOmega = 'cache refresh failure data pipeline omega';

    const now = new Date();
    const bases: string[] = [];

    for (const order of [
      [contentAlpha, contentOmega],
      [contentOmega, contentAlpha],
    ]) {
      const home = makeRoot('dedupe-det-7');
      for (const content of order) {
        writeEntry(home, {
          ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic }),
          created: now.toISOString(),
        });
      }

      const result = await consolidate(home, { now });
      expect(result.merged).toBe(2);

      const semantics = loadAllEntries(home, 'default').filter(
        (e) =>
          e.layer === Layer.Semantic && e.content.startsWith('[Consolidated from 2 related memories, newest first]'),
      );
      expect(semantics.length).toBe(1);
      bases.push(semantics[0].content.split('\n\n')[1].split('\n')[0]);
    }

    expect(bases[0]).toBe(bases[1]);
    expect(bases[0]).toBe(`- ${contentAlpha}`);
  });

  it('8. strengthTieKey maps non-finite strength to bucket 0 and the assembled comparator chain never returns NaN', () => {
    expect(strengthTieKey(NaN)).toBe(0);
    expect(strengthTieKey(Infinity)).toBe(0);
    expect(strengthTieKey(-Infinity)).toBe(0);
    expect(strengthTieKey(null)).toBe(0);
    expect(strengthTieKey(undefined)).toBe(0);
    expect(strengthTieKey(0)).toBe(0);
    expect(strengthTieKey(1)).toBe(100);

    const a = { id: 'aaa-nan', content: 'alpha content', strength: NaN, retrievalCount: 0 };
    const b = { id: 'bbb-normal', content: 'beta content', strength: 0.5, retrievalCount: 0 };

    const bucketDiff = strengthTieKey(b.strength) - strengthTieKey(a.strength);
    expect(Number.isNaN(bucketDiff)).toBe(false);

    const retrievalDiff = (b.retrievalCount ?? 0) - (a.retrievalCount ?? 0);
    expect(Number.isNaN(retrievalDiff)).toBe(false);

    const identity = compareEntryIdentity(a, b);
    expect(Number.isNaN(identity)).toBe(false);

    const cmp = bucketDiff !== 0 ? bucketDiff : retrievalDiff !== 0 ? retrievalDiff : identity;
    expect(Number.isNaN(cmp)).toBe(false);
    expect(Number.isFinite(cmp)).toBe(true);
  });

  const TWIN_TEXT = 'byte identical twin content for the survivor metadata cases';

  async function survivorAfterDedupe(order: ReturnType<typeof createMemory>[]) {
    const home = makeRoot('dedupe-det-meta');
    for (const entry of order) writeEntry(home, entry);
    const result = await deduplicateStore(sqliteStore(home));
    expect(result.removed).toBe(order.length - 1);
    const remaining = loadAllEntries(home, 'default');
    expect(remaining.length).toBe(1);
    return { survivor: remaining[0], pairs: result.pairs };
  }

  it('9. twins differing only in tags keep the copy with the most tags in both ingest orders', async () => {
    const twins = [['a'], ['b'], ['c'], ['d', 'e']].map((tags) =>
      createMemory(TWIN_TEXT, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags }),
    );
    const forward = (await survivorAfterDedupe(twins)).survivor;
    const reversed = (await survivorAfterDedupe([...twins].reverse())).survivor;
    expect([...forward.tags].sort()).toEqual(['d', 'e']);
    expect([...reversed.tags].sort()).toEqual(['d', 'e']);
  });

  it('10. twins differing only in source keep the lowest source in both ingest orders', async () => {
    const twins = ['src-c', 'src-a', 'src-d', 'src-b'].map((source) =>
      createMemory(TWIN_TEXT, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, source }),
    );
    expect((await survivorAfterDedupe(twins)).survivor.source).toBe('src-a');
    expect((await survivorAfterDedupe([...twins].reverse())).survivor.source).toBe('src-a');
  });

  it('11. episodic/semantic twins keep the semantic copy in both ingest orders (was the episodic one via the mem_/sem_ id prefix)', async () => {
    const episodic = createMemory(TWIN_TEXT, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic });
    const semantic = createMemory(TWIN_TEXT, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Semantic });
    for (const order of [
      [episodic, semantic],
      [semantic, episodic],
    ]) {
      const { survivor, pairs } = await survivorAfterDedupe(order);
      expect(survivor.layer).toBe(Layer.Semantic);
      expect(pairs).toHaveLength(1);
      expect(pairs[0].keptLayer).toBe(Layer.Semantic);
      expect(pairs[0].removedLayer).toBe(Layer.Episodic);
    }
  });

  it('12. a raw (append-only) episodic twin is not a dedupe candidate, so sleep no longer aborts on the delete trigger', async () => {
    const raw = createMemory(TWIN_TEXT, {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      kind: 'raw',
    });
    const semantic = createMemory(TWIN_TEXT, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Semantic });
    for (const order of [
      [raw, semantic],
      [semantic, raw],
    ]) {
      const home = makeRoot('dedupe-det-raw');
      for (const entry of order) writeEntry(home, entry);
      const result = await deduplicateStore(sqliteStore(home));
      expect(result.removed).toBe(0);
      expect(result.pairs).toHaveLength(0);
      const ids = loadAllEntries(home, 'default')
        .map((e) => e.id)
        .sort();
      expect(ids).toEqual([raw.id, semantic.id].sort());
    }
  });

  it('13. a superseded semantic twin never outranks the current episodic re-ingest', async () => {
    const home = makeRoot('dedupe-det-superseded');
    const successor = createMemory('unrelated successor text that replaced the old semantic row', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
    });
    const stale = {
      ...createMemory(TWIN_TEXT, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Semantic }),
      supersededBy: successor.id,
      kind: 'superseded' as const,
    };
    const current = createMemory(TWIN_TEXT, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic });
    for (const entry of [successor, stale, current]) writeEntry(home, entry);
    const result = await deduplicateStore(sqliteStore(home));
    expect(result.removed).toBe(0);
    expect(result.pairs).toHaveLength(0);
    const ids = loadAllEntries(home, 'default')
      .map((e) => e.id)
      .sort();
    expect(ids).toEqual([successor.id, stale.id, current.id].sort());
  });

  it('14. mergeContents 3+ bullets: bullet order and merged tags identical across all 6 ingest orders (base order: created desc -> content asc)', async () => {
    const textA =
      'our deployment pipeline automatically runs full suite of integration tests before every production release each week without exception this time';
    const textB =
      'the nightly pipeline automatically runs full suite of integration tests before every production release each week without exception this time';
    const textC =
      'the deployment pipeline automatically runs full suite of integration tests before every production release each week without exception last time';

    const now = new Date();
    const variants = [
      { content: textA, tags: ['t-a'] },
      { content: textB, tags: ['t-b'] },
      { content: textC, tags: ['t-c'] },
    ];
    const expectedOrder = [...variants].sort((a, b) => (a.content < b.content ? -1 : a.content > b.content ? 1 : 0));
    const expectedBlock = expectedOrder.map((v) => `- ${v.content}`).join('\n');

    for (const perm of permutationsOf3()) {
      const home = makeRoot('dedupe-det-14');
      for (const idx of perm) {
        writeEntry(home, {
          ...createMemory(variants[idx].content, {
            baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
            layer: Layer.Episodic,
            tags: variants[idx].tags,
          }),
          created: now.toISOString(),
        });
      }

      const result = await consolidate(home, { now });
      expect(result.merged).toBe(3);

      const semantics = loadAllEntries(home, 'default').filter(
        (e) =>
          e.layer === Layer.Semantic &&
          e.content.startsWith('[Consolidated pattern from 3 related memories, newest first]'),
      );
      expect(semantics.length).toBe(1);
      expect(semantics[0].content.split('\n\n')[1]).toBe(expectedBlock);
      expect([...semantics[0].tags]).toEqual(['t-a', 't-b', 't-c']);
    }
  });
});
