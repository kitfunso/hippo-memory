/**
 * L1 — graph-retrieval stream producer tests (real SQLite, no mocks).
 * Docs: docs/plans/2026-06-02-l1-graph-rrf-stream.md
 *
 * Covers selectGraphSeeds (pure top-by-lexical-rank) and graphRankStream (seed->neighbour
 * scoring, per-hop decay ordering, fanout cap, local+global expansion, dedup max-score,
 * deterministic ties, empty-graph no-op, not-in-pool ignored, seeds-never-scored incl.
 * the seed-linked-to-another-seed case).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { insertEntity, insertRelation } from '../src/graph.js';
import {
  selectGraphSeeds,
  graphRankStream,
  type GraphSeed,
} from '../src/graph-stream.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-graphstream-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function mem(home: string, tenant: string, text: string): MemoryEntry {
  const content = text.length < 3 ? text.repeat(3) : text;
  const m = createMemory(content, { tags: [], layer: Layer.Semantic, confidence: 'verified', source: 'test', tenantId: tenant });
  writeEntry(home, m, { actor: 'test' });
  return m;
}
function ent(home: string, tenant: string, m: MemoryEntry, name: string): number {
  return insertEntity(home, tenant, { entityType: 'decision', name, memoryId: m.id }).id;
}
const seed = (index: number, strength = 1.0): GraphSeed => ({ index, strength });
/** Like `mem`, but with an explicit envelope scope (v1.26.1 pool-only pinning case). */
function scopedMem(home: string, tenant: string, text: string, scope: string): MemoryEntry {
  const content = text.length < 3 ? text.repeat(3) : text;
  const m = createMemory(content, { tags: [], layer: Layer.Semantic, confidence: 'verified', source: 'test', tenantId: tenant, scope });
  writeEntry(home, m, { actor: 'test' });
  return m;
}

describe('selectGraphSeeds (pure)', () => {
  it('picks top-N by best lexical rank across both lists; strength = 1/(bestRank+1)', () => {
    // bm25Ranked=[2,0,1] -> 2@0,0@1,1@2 ; cosineRanked=[1,2,0] -> 1@0,2@1,0@2
    // bestPos: {2:0, 0:1, 1:0} -> sorted (pos asc, index asc): idx1@0, idx2@0, idx0@1
    const seeds = selectGraphSeeds([2, 0, 1], [1, 2, 0], 2);
    expect(seeds).toEqual([
      { index: 1, strength: 1 / 1 },
      { index: 2, strength: 1 / 1 },
    ]);
  });
  it('seedCount<=0 -> []', () => {
    expect(selectGraphSeeds([0, 1], [1, 0], 0)).toEqual([]);
  });
  it('a candidate present in only one list is still eligible', () => {
    // idx 5 only in cosine; bm25=[0] -> 0@0 ; cosine=[5,0] -> 5@0,0@1. bestPos {0:0,5:0}
    const seeds = selectGraphSeeds([0], [5, 0], 5);
    expect(seeds.map((s) => s.index).sort((a, b) => a - b)).toEqual([0, 5]);
  });
});

describe('L1 graphRankStream (real SQLite)', () => {
  let home: string;
  const T = 'default';
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => safeRmSync(home));

  it('scores a 1-hop neighbour; excludes the seed and unrelated in-pool entries', () => {
    const a = mem(home, T, 'alpha cache invalidation decision');
    const b = mem(home, T, 'unrelated wording xyzzy plugh');
    const x = mem(home, T, 'no graph path at all');
    const ea = ent(home, T, a, 'A'); const eb = ent(home, T, b, 'B');
    ent(home, T, x, 'X');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });

    const entries = [a, b, x];
    const out = graphRankStream(entries, [seed(0)], { hippoRoot: home, tenantId: T });
    expect(out).toEqual([1]);          // only b; seed(0) and x(2) excluded
  });

  it('orders a 1-hop neighbour above a 2-hop neighbour (per-hop decay)', () => {
    const a = mem(home, T, 'aaa'); const b = mem(home, T, 'bbb'); const c = mem(home, T, 'ccc');
    const ea = ent(home, T, a, 'A'); const eb = ent(home, T, b, 'B'); const ec = ent(home, T, c, 'C');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelation(home, T, { fromEntityId: eb, toEntityId: ec, relType: 'supersedes', memoryId: b.id });

    const entries = [a, b, c];
    const out = graphRankStream(entries, [seed(0)], { hippoRoot: home, tenantId: T, hops: 2 });
    expect(out).toEqual([1, 2]);       // b (1-hop) before c (2-hop)
    // hops:1 reaches only b
    expect(graphRankStream(entries, [seed(0)], { hippoRoot: home, tenantId: T, hops: 1 })).toEqual([1]);
  });

  it('enforces the per-hop fanout cap', () => {
    const a = mem(home, T, 'seed node');
    const ns = [0, 1, 2].map((i) => mem(home, T, `neighbour ${i} xyz`));
    const ea = ent(home, T, a, 'A');
    for (const n of ns) {
      const en = ent(home, T, n, `N${n.id}`);
      insertRelation(home, T, { fromEntityId: ea, toEntityId: en, relType: 'supersedes', memoryId: a.id });
    }
    const entries = [a, ...ns];
    const out = graphRankStream(entries, [seed(0)], { hippoRoot: home, tenantId: T, maxNeighbors: 2 });
    expect(out.length).toBe(2);        // capped at 2 of the 3 neighbours
  });

  it('deterministic ties: equal hop+strength neighbours order by index asc', () => {
    const a = mem(home, T, 'aaa'); const b = mem(home, T, 'bbb'); const c = mem(home, T, 'ccc');
    const ea = ent(home, T, a, 'A'); const eb = ent(home, T, b, 'B'); const ec = ent(home, T, c, 'C');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelation(home, T, { fromEntityId: ea, toEntityId: ec, relType: 'supersedes', memoryId: a.id });
    const out = graphRankStream([a, b, c], [seed(0)], { hippoRoot: home, tenantId: T });
    expect(out).toEqual([1, 2]);       // b and c both 1-hop from a -> index asc
  });

  it('empty graph -> [] (no-op; caller skips the 3rd list)', () => {
    const a = mem(home, T, 'aaa'); const b = mem(home, T, 'bbb');
    // no entities, no relations
    expect(graphRankStream([a, b], [seed(0)], { hippoRoot: home, tenantId: T })).toEqual([]);
  });

  it('a reached neighbour NOT in the candidate pool is ignored', () => {
    const a = mem(home, T, 'aaa'); const b = mem(home, T, 'bbb');
    const ea = ent(home, T, a, 'A'); const eb = ent(home, T, b, 'B');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    // pool excludes b
    const entries = [a, mem(home, T, 'other in pool but no path')];
    expect(graphRankStream(entries, [seed(0)], { hippoRoot: home, tenantId: T })).toEqual([]);
  });

  it('v1.26.1: a graph-reachable OUT-of-pool private-scoped memory never appears in the stream output (pool-only pin)', () => {
    // graph-stream.ts is re-rank-only: it scores entries[] indices, never loads or
    // surfaces memory content the caller did not already admit into the pool. Unlike
    // graph-recall.ts (which loads reached rows by id and needed a scope predicate added,
    // v1.26.1), this module has no such load path — the caller's own scope-filtered
    // candidate pool is what keeps a private-scoped neighbour out, by construction. The
    // pin asserts on a NON-EMPTY output (code-review-critic: empty-output would be
    // vacuous): the public in-pool neighbour must rank while the equally-graph-reachable
    // private row, absent from the pool, must not appear.
    const a = mem(home, T, 'alpha cache invalidation decision');
    const pub = mem(home, T, 'public in-pool neighbour of alpha');
    const priv = scopedMem(home, T, 'private out-of-pool neighbour wording xyzzy', 'slack:private:dm1');
    const ea = ent(home, T, a, 'A');
    const ePub = ent(home, T, pub, 'PUB');
    const ePriv = ent(home, T, priv, 'PRIV');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: ePub, relType: 'supersedes', memoryId: a.id });
    insertRelation(home, T, { fromEntityId: ea, toEntityId: ePriv, relType: 'supersedes', memoryId: a.id });

    // pool excludes priv (simulating the caller's own scope-filtered candidate pool).
    const entries = [a, pub];
    const out = graphRankStream(entries, [seed(0)], { hippoRoot: home, tenantId: T });
    expect(out).toEqual([1]); // pub ranked — the pin is exercised, not vacuous...
    expect(out.map((i) => entries[i].id)).not.toContain(priv.id); // ...and priv never appears
  });

  it('seeds are never scored — even when a seed is graph-adjacent to another seed', () => {
    const a = mem(home, T, 'aaa'); const b = mem(home, T, 'bbb'); const c = mem(home, T, 'ccc');
    const ea = ent(home, T, a, 'A'); const eb = ent(home, T, b, 'B'); const ec = ent(home, T, c, 'C');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id }); // a-b (both seeds)
    insertRelation(home, T, { fromEntityId: ea, toEntityId: ec, relType: 'supersedes', memoryId: a.id }); // a-c (c not a seed)
    const out = graphRankStream([a, b, c], [seed(0), seed(1, 0.5)], { hippoRoot: home, tenantId: T });
    expect(out).toEqual([2]);          // only c; seeds 0 and 1 excluded
  });

  it('a neighbour reachable from two seeds at the same hop takes the STRONGER seed (codex P2)', () => {
    // nShared is 1-hop from a strong seed AND a weak seed; nWeakOnly is 1-hop from the weak
    // seed only. With the strongest-same-hop-seed fix, nShared outscores nWeakOnly and ranks
    // above it even though nShared has the HIGHER index (so it is strength order, not index
    // order — which would have tied them if nShared were locked to the weak seed's strength).
    const seedStrong = mem(home, T, 'strong seed aaa');
    const seedWeak = mem(home, T, 'weak seed bbb');
    const nWeakOnly = mem(home, T, 'weak-only neighbour ccc');  // index 2
    const filler = mem(home, T, 'filler no edge ddd');          // index 3
    const nShared = mem(home, T, 'shared neighbour eee');       // index 4
    const eStrong = ent(home, T, seedStrong, 'STRONG');
    const eWeak = ent(home, T, seedWeak, 'WEAK');
    const eWeakOnly = ent(home, T, nWeakOnly, 'WONLY');
    ent(home, T, filler, 'FILL');
    const eShared = ent(home, T, nShared, 'SHARED');
    // Insert strong->shared FIRST (lower id) then weak->shared (higher id, returned first by
    // the loader's id-DESC order) — the exact ordering that would mis-score under the bug.
    insertRelation(home, T, { fromEntityId: eStrong, toEntityId: eShared, relType: 'supersedes', memoryId: seedStrong.id });
    insertRelation(home, T, { fromEntityId: eWeak, toEntityId: eShared, relType: 'supersedes', memoryId: seedWeak.id });
    insertRelation(home, T, { fromEntityId: eWeak, toEntityId: eWeakOnly, relType: 'supersedes', memoryId: seedWeak.id });

    const entries = [seedStrong, seedWeak, nWeakOnly, filler, nShared];
    const out = graphRankStream(entries, [seed(0, 1.0), seed(1, 0.3)], { hippoRoot: home, tenantId: T });
    expect(out).toEqual([4, 2]);       // nShared (strong, index 4) ranks ABOVE nWeakOnly (weak, index 2)
  });

  it('expands across the global store (a global seed reaches a global neighbour)', () => {
    const glob = makeRoot();
    try {
      const g = mem(glob, T, 'global seed'); const gn = mem(glob, T, 'global neighbour');
      const eg = ent(glob, T, g, 'G'); const egn = ent(glob, T, gn, 'GN');
      insertRelation(glob, T, { fromEntityId: eg, toEntityId: egn, relType: 'supersedes', memoryId: g.id });
      const entries = [g, gn];         // pool = the two global memories
      const out = graphRankStream(entries, [seed(0)], { hippoRoot: home, tenantId: T, globalRoot: glob });
      expect(out).toEqual([1]);        // gn reached via the global graph
    } finally { safeRmSync(glob); }
  });
});
