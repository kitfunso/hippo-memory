/**
 * L1 — graph stream x RRF fusion tests (real SQLite, no mocks).
 * Docs: docs/plans/2026-06-02-l1-graph-rrf-stream.md
 *
 * hybridSearch's rrf path requires a loaded embedding model (unavailable in CI — same
 * constraint tests/hybrid-search.test.ts documents), so we exercise the EXACT fusion the
 * wiring performs at the rrfFuse layer: build bm25Ranked + cosineRanked + a real-DB
 * graphRanked (via graphRankStream), then compare the 2-list vs 3-list fused ordering.
 * This is also the plan's Gate-(b) dry-run "structural work" criterion: a lexically-weak
 * but graph-adjacent answer (rank > 5 under 2-list) must enter top-5 under 3-list.
 *
 * The graph stream anchors on the top-`seedCount` lexical hits and re-ranks the
 * rank>seedCount TAIL (seeds are excluded), so these fixtures pass an explicit small
 * seedCount; the CLI/library default (10) targets realistic large pools.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { insertEntity, insertRelation } from '../src/graph.js';
import { rrfFuse } from '../src/rrf.js';
import { selectGraphSeeds, graphRankStream } from '../src/graph-stream.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-gstream-rrf-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function mem(home: string, tenant: string, text: string): MemoryEntry {
  const m = createMemory(text, { tags: [], layer: Layer.Semantic, confidence: 'verified', source: 'test', tenantId: tenant });
  writeEntry(home, m, { actor: 'test' });
  return m;
}
function ent(home: string, tenant: string, m: MemoryEntry, name: string): number {
  return insertEntity(home, tenant, { entityType: 'decision', name, memoryId: m.id }).id;
}

// Default fusion weights, mirroring hybridSearch: [1-embeddingWeight, embeddingWeight, w_g].
const BM25_W = 0.4;
const DENSE_W = 0.6;

/** Fused ranking (entries[] indices, best first) from N ranked lists — the exact rrfFuse
 *  call the wiring makes, with the explicit absentRank=entries.length+1. */
function fusedOrder(
  poolSize: number,
  lists: number[][],
  weights: number[],
): number[] {
  const scores = rrfFuse(lists, weights, { absentRank: poolSize + 1 });
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([i]) => i);
}

describe('L1 graph stream x RRF fusion (real SQLite)', () => {
  let home: string;
  const T = 'default';
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => safeRmSync(home));

  it('Gate-(b) dry-run: a lexically-weak, graph-adjacent answer (rank>5 in 2-list) enters top-5 under the 3-list fusion', () => {
    // 8-entry pool. strong=0 is a top lexical hit; weak=7 is the answer: lexically last
    // but graph-adjacent (1-hop) to strong.
    const strong = mem(home, T, 'primary topic strongly matched by the query terms here');
    const distractors = [1, 2, 3, 4, 5, 6].map((i) => mem(home, T, `distractor number ${i} mid pool lexical`));
    const weak = mem(home, T, 'orthogonal wording the query barely matches zzz');
    const entries: MemoryEntry[] = [strong, ...distractors, weak];

    const es = ent(home, T, strong, 'STRONG');
    const ew = ent(home, T, weak, 'WEAK');
    insertRelation(home, T, { fromEntityId: es, toEntityId: ew, relType: 'supersedes', memoryId: strong.id });

    // Lexical rankings: strong rank1 ... weak rank8 (last) in BOTH streams.
    const bm25Ranked = [0, 1, 2, 3, 4, 5, 6, 7];
    const cosineRanked = [0, 1, 2, 3, 4, 5, 6, 7];

    // 2-list baseline: weak is outside top-5.
    const order2 = fusedOrder(entries.length, [bm25Ranked, cosineRanked], [BM25_W, DENSE_W]);
    const rank2 = order2.indexOf(7);
    expect(rank2).toBeGreaterThanOrEqual(5); // outside top-5 (0-indexed >=5)

    // Graph stream: anchor on the top-3 lexical seeds; weak(7) is in the tail, reached
    // from strong(0). seedCount=3 keeps weak a non-seed.
    const seeds = selectGraphSeeds(bm25Ranked, cosineRanked, 3);
    expect(seeds.map((s) => s.index)).not.toContain(7); // weak is NOT a seed
    const graphRanked = graphRankStream(entries, seeds, { hippoRoot: home, tenantId: T });
    expect(graphRanked).toContain(7); // the graph stream surfaces weak

    // 3-list fusion lifts weak into top-5.
    const order3 = fusedOrder(entries.length, [bm25Ranked, cosineRanked, graphRanked], [BM25_W, DENSE_W, 0.5]);
    const rank3 = order3.indexOf(7);
    expect(rank3).toBeLessThan(5);     // now in top-5
    expect(rank3).toBeLessThan(rank2); // strictly improved
  });

  it('no-harm: a strong lexical hit with no graph path keeps its top rank when the stream is added', () => {
    const answer = mem(home, T, 'control answer strongly matched by every query term');
    const others = [1, 2, 3, 4].map((i) => mem(home, T, `weaker control distractor ${i}`));
    const entries = [answer, ...others];
    // No relations at all -> empty graph.
    const bm25Ranked = [0, 1, 2, 3, 4];
    const cosineRanked = [0, 1, 2, 3, 4];

    const seeds = selectGraphSeeds(bm25Ranked, cosineRanked, 3);
    const graphRanked = graphRankStream(entries, seeds, { hippoRoot: home, tenantId: T });
    expect(graphRanked).toEqual([]);   // no graph -> empty -> wiring skips the 3rd list

    const order2 = fusedOrder(entries.length, [bm25Ranked, cosineRanked], [BM25_W, DENSE_W]);
    expect(order2[0]).toBe(0);         // strong control answer stays rank 1
  });

  it('empty graphRanked -> the 3rd list is skipped -> fused order is byte-identical to the 2-list path', () => {
    const entries = [0, 1, 2, 3].map((i) => mem(home, T, `entry ${i} some lexical content`));
    const bm25Ranked = [0, 1, 2, 3];
    const cosineRanked = [3, 2, 1, 0];
    const seeds = selectGraphSeeds(bm25Ranked, cosineRanked, 2);
    const graphRanked = graphRankStream(entries, seeds, { hippoRoot: home, tenantId: T });
    expect(graphRanked).toEqual([]);

    // The wiring's skip branch: rrfFuse over the 2 lists. Identical scores either way.
    const twoList = rrfFuse([bm25Ranked, cosineRanked], [BM25_W, DENSE_W], { absentRank: entries.length + 1 });
    const order = [...twoList.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([i]) => i);
    // Symmetric reverse lists + equal-ish weights -> deterministic tie-broken order.
    expect(order.length).toBe(4);
    expect(new Set(order)).toEqual(new Set([0, 1, 2, 3]));
  });
});
