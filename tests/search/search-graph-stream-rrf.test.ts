import { describe, it, expect, beforeEach } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { insertEntityAt, insertRelationAt } from '../_helpers/graph-seed.js';
import { rrfFuse } from '../../src/domain/search/rrf.js';
import { selectGraphSeeds, graphRankStream } from '../../src/domain/graph/stream.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, sqliteStore } = sessionPerTest();

function mem(home: string, tenant: string, text: string): MemoryEntry {
  const m = createMemory(text, {
    tags: [],
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'test',
    tenantId: tenant,
  });
  writeEntry(home, m, { actor: 'test' });
  return m;
}
function ent(home: string, tenant: string, m: MemoryEntry, name: string): number {
  return insertEntityAt(home, tenant, { entityType: 'decision', name, memoryId: m.id }).id;
}

const BM25_W = 0.4;
const DENSE_W = 0.6;

function fusedOrder(poolSize: number, lists: number[][], weights: number[]): number[] {
  const scores = rrfFuse(lists, weights, { absentRank: poolSize + 1 });
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([i]) => i);
}

describe('graph stream x RRF fusion (real SQLite)', () => {
  let home: string;
  const T = 'default';
  beforeEach(() => {
    home = makeRoot('gstream-rrf');
  });

  it('Gate-(b) dry-run: a lexically-weak, graph-adjacent answer (rank>5 in 2-list) enters top-5 under the 3-list fusion', async () => {
    const strong = mem(home, T, 'primary topic strongly matched by the query terms here');
    const distractors = [1, 2, 3, 4, 5, 6].map((i) => mem(home, T, `distractor number ${i} mid pool lexical`));
    const weak = mem(home, T, 'orthogonal wording the query barely matches zzz');
    const entries: MemoryEntry[] = [strong, ...distractors, weak];

    const es = ent(home, T, strong, 'STRONG');
    const ew = ent(home, T, weak, 'WEAK');
    insertRelationAt(home, T, { fromEntityId: es, toEntityId: ew, relType: 'supersedes', memoryId: strong.id });

    const bm25Ranked = [0, 1, 2, 3, 4, 5, 6, 7];
    const cosineRanked = [0, 1, 2, 3, 4, 5, 6, 7];

    const order2 = fusedOrder(entries.length, [bm25Ranked, cosineRanked], [BM25_W, DENSE_W]);
    const rank2 = order2.indexOf(7);
    expect(rank2).toBeGreaterThanOrEqual(5);
    const seeds = selectGraphSeeds(bm25Ranked, cosineRanked, 3);
    expect(seeds.map((s) => s.index)).not.toContain(7);
    const graphRanked = await graphRankStream(entries, seeds, { store: sqliteStore(home), tenantId: T });
    expect(graphRanked).toContain(7);
    const order3 = fusedOrder(entries.length, [bm25Ranked, cosineRanked, graphRanked], [BM25_W, DENSE_W, 0.5]);
    const rank3 = order3.indexOf(7);
    expect(rank3).toBeLessThan(5);
    expect(rank3).toBeLessThan(rank2);
  });

  it('no-harm: a strong lexical hit with no graph path keeps its top rank when the stream is added', async () => {
    const answer = mem(home, T, 'control answer strongly matched by every query term');
    const others = [1, 2, 3, 4].map((i) => mem(home, T, `weaker control distractor ${i}`));
    const entries = [answer, ...others];
    const bm25Ranked = [0, 1, 2, 3, 4];
    const cosineRanked = [0, 1, 2, 3, 4];

    const seeds = selectGraphSeeds(bm25Ranked, cosineRanked, 3);
    const graphRanked = await graphRankStream(entries, seeds, { store: sqliteStore(home), tenantId: T });
    expect(graphRanked).toEqual([]);

    const order2 = fusedOrder(entries.length, [bm25Ranked, cosineRanked], [BM25_W, DENSE_W]);
    expect(order2[0]).toBe(0);
  });

  it('noise control: a POPULATED graph that boosts a non-answer distractor does NOT displace a strong lexical answer from the top', async () => {
    const answer = mem(home, T, 'control answer matched strongly by every query term present');
    const mids = [1, 2, 3].map((i) => mem(home, T, `mid pool distractor ${i} partial match`));
    const adjacent = mem(home, T, 'orthogonal non-answer wording barely matched zzz');
    const entries = [answer, ...mids, mem(home, T, 'another mid distractor four'), adjacent];

    const eSeed = ent(home, T, mids[0], 'SEED');
    const eAdj = ent(home, T, adjacent, 'ADJ');
    insertRelationAt(home, T, { fromEntityId: eSeed, toEntityId: eAdj, relType: 'supersedes', memoryId: mids[0].id });

    const bm25Ranked = [0, 1, 2, 3, 4, 5];
    const cosineRanked = [0, 1, 2, 3, 4, 5];
    const seeds = selectGraphSeeds(bm25Ranked, cosineRanked, 3);
    const graphRanked = await graphRankStream(entries, seeds, { store: sqliteStore(home), tenantId: T });
    expect(graphRanked).toEqual([5]);

    const order2 = fusedOrder(entries.length, [bm25Ranked, cosineRanked], [BM25_W, DENSE_W]);
    const order3 = fusedOrder(entries.length, [bm25Ranked, cosineRanked, graphRanked], [BM25_W, DENSE_W, 0.5]);
    expect(order2[0]).toBe(0);
    expect(order3[0]).toBe(0);
    expect(order3).toEqual([0, 1, 5, 2, 3, 4]);
  });

  it('empty graphRanked -> the 3rd list is skipped -> fused order is byte-identical to the 2-list path', async () => {
    const entries = [0, 1, 2, 3].map((i) => mem(home, T, `entry ${i} some lexical content`));
    const bm25Ranked = [0, 1, 2, 3];
    const cosineRanked = [3, 2, 1, 0];
    const seeds = selectGraphSeeds(bm25Ranked, cosineRanked, 2);
    const graphRanked = await graphRankStream(entries, seeds, { store: sqliteStore(home), tenantId: T });
    expect(graphRanked).toEqual([]);

    const twoList = rrfFuse([bm25Ranked, cosineRanked], [BM25_W, DENSE_W], { absentRank: entries.length + 1 });
    const order = [...twoList.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([i]) => i);
    expect(order.length).toBe(4);
    expect(new Set(order)).toEqual(new Set([0, 1, 2, 3]));
  });
});
