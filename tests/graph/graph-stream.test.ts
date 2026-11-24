import { describe, it, expect, beforeEach } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { insertEntityAt, insertRelationAt } from '../_helpers/graph-seed.js';
import { selectGraphSeeds, graphRankStream, type GraphSeed } from '../../src/domain/graph/stream.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

function safeRmSync(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
const { writeEntry, sqliteStore } = sessionPerTest();

function mem(home: string, tenant: string, text: string): MemoryEntry {
  const content = text.length < 3 ? text.repeat(3) : text;
  const m = createMemory(content, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
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
const seed = (index: number, strength = 1.0): GraphSeed => ({ index, strength });
function scopedMem(home: string, tenant: string, text: string, scope: string): MemoryEntry {
  const content = text.length < 3 ? text.repeat(3) : text;
  const m = createMemory(content, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    tags: [],
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'test',
    tenantId: tenant,
    scope,
  });
  writeEntry(home, m, { actor: 'test' });
  return m;
}

describe('selectGraphSeeds (pure)', () => {
  it('picks top-N by best lexical rank across both lists; strength = 1/(bestRank+1)', () => {
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
    const seeds = selectGraphSeeds([0], [5, 0], 5);
    expect(seeds.map((s) => s.index).sort((a, b) => a - b)).toEqual([0, 5]);
  });
});

describe('graphRankStream (real SQLite)', () => {
  let home: string;
  const T = 'default';
  beforeEach(() => {
    home = makeRoot('graphstream');
  });

  it('scores a 1-hop neighbour; excludes the seed and unrelated in-pool entries', async () => {
    const a = mem(home, T, 'alpha cache invalidation decision');
    const b = mem(home, T, 'unrelated wording xyzzy plugh');
    const x = mem(home, T, 'no graph path at all');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    ent(home, T, x, 'X');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });

    const entries = [a, b, x];
    const out = await graphRankStream(entries, [seed(0)], { store: sqliteStore(home), tenantId: T });
    expect(out).toEqual([1]);
  });

  it('orders a 1-hop neighbour above a 2-hop neighbour (per-hop decay)', async () => {
    const a = mem(home, T, 'aaa');
    const b = mem(home, T, 'bbb');
    const c = mem(home, T, 'ccc');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    const ec = ent(home, T, c, 'C');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelationAt(home, T, { fromEntityId: eb, toEntityId: ec, relType: 'supersedes', memoryId: b.id });

    const entries = [a, b, c];
    const out = await graphRankStream(entries, [seed(0)], { store: sqliteStore(home), tenantId: T, hops: 2 });
    expect(out).toEqual([1, 2]);
    expect(await graphRankStream(entries, [seed(0)], { store: sqliteStore(home), tenantId: T, hops: 1 })).toEqual([1]);
  });

  it('enforces the per-hop fanout cap', async () => {
    const a = mem(home, T, 'seed node');
    const ns = [0, 1, 2].map((i) => mem(home, T, `neighbour ${i} xyz`));
    const ea = ent(home, T, a, 'A');
    for (const n of ns) {
      const en = ent(home, T, n, `N${n.id}`);
      insertRelationAt(home, T, { fromEntityId: ea, toEntityId: en, relType: 'supersedes', memoryId: a.id });
    }
    const entries = [a, ...ns];
    const out = await graphRankStream(entries, [seed(0)], { store: sqliteStore(home), tenantId: T, maxNeighbors: 2 });
    expect(out.length).toBe(2);
  });

  it('deterministic ties: equal hop+strength neighbours order by index asc', async () => {
    const a = mem(home, T, 'aaa');
    const b = mem(home, T, 'bbb');
    const c = mem(home, T, 'ccc');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    const ec = ent(home, T, c, 'C');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: ec, relType: 'supersedes', memoryId: a.id });
    const out = await graphRankStream([a, b, c], [seed(0)], { store: sqliteStore(home), tenantId: T });
    expect(out).toEqual([1, 2]);
  });

  it('empty graph -> [] (no-op; caller skips the 3rd list)', async () => {
    const a = mem(home, T, 'aaa');
    const b = mem(home, T, 'bbb');
    expect(await graphRankStream([a, b], [seed(0)], { store: sqliteStore(home), tenantId: T })).toEqual([]);
  });

  it('a reached neighbour NOT in the candidate pool is ignored', async () => {
    const a = mem(home, T, 'aaa');
    const b = mem(home, T, 'bbb');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    const entries = [a, mem(home, T, 'other in pool but no path')];
    expect(await graphRankStream(entries, [seed(0)], { store: sqliteStore(home), tenantId: T })).toEqual([]);
  });

  it('a graph-reachable OUT-of-pool private-scoped memory never appears in the stream output (pool-only pin)', async () => {
    const a = mem(home, T, 'alpha cache invalidation decision');
    const pub = mem(home, T, 'public in-pool neighbour of alpha');
    const priv = scopedMem(home, T, 'private out-of-pool neighbour wording xyzzy', 'slack:private:dm1');
    const ea = ent(home, T, a, 'A');
    const ePub = ent(home, T, pub, 'PUB');
    const ePriv = ent(home, T, priv, 'PRIV');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: ePub, relType: 'supersedes', memoryId: a.id });
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: ePriv, relType: 'supersedes', memoryId: a.id });

    const entries = [a, pub];
    const out = await graphRankStream(entries, [seed(0)], { store: sqliteStore(home), tenantId: T });
    expect(out).toEqual([1]);
    expect(out.map((i) => entries[i].id)).not.toContain(priv.id);
  });

  it('seeds are never scored, even when a seed is graph-adjacent to another seed', async () => {
    const a = mem(home, T, 'aaa');
    const b = mem(home, T, 'bbb');
    const c = mem(home, T, 'ccc');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    const ec = ent(home, T, c, 'C');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: ec, relType: 'supersedes', memoryId: a.id });
    const out = await graphRankStream([a, b, c], [seed(0), seed(1, 0.5)], { store: sqliteStore(home), tenantId: T });
    expect(out).toEqual([2]);
  });

  it('a neighbour reachable from two seeds at the same hop takes the STRONGER seed', async () => {
    const seedStrong = mem(home, T, 'strong seed aaa');
    const seedWeak = mem(home, T, 'weak seed bbb');
    const nWeakOnly = mem(home, T, 'weak-only neighbour ccc');
    const filler = mem(home, T, 'filler no edge ddd');
    const nShared = mem(home, T, 'shared neighbour eee');
    const eStrong = ent(home, T, seedStrong, 'STRONG');
    const eWeak = ent(home, T, seedWeak, 'WEAK');
    const eWeakOnly = ent(home, T, nWeakOnly, 'WONLY');
    ent(home, T, filler, 'FILL');
    const eShared = ent(home, T, nShared, 'SHARED');
    insertRelationAt(home, T, {
      fromEntityId: eStrong,
      toEntityId: eShared,
      relType: 'supersedes',
      memoryId: seedStrong.id,
    });
    insertRelationAt(home, T, {
      fromEntityId: eWeak,
      toEntityId: eShared,
      relType: 'supersedes',
      memoryId: seedWeak.id,
    });
    insertRelationAt(home, T, {
      fromEntityId: eWeak,
      toEntityId: eWeakOnly,
      relType: 'supersedes',
      memoryId: seedWeak.id,
    });

    const entries = [seedStrong, seedWeak, nWeakOnly, filler, nShared];
    const out = await graphRankStream(entries, [seed(0, 1.0), seed(1, 0.3)], { store: sqliteStore(home), tenantId: T });
    expect(out).toEqual([4, 2]);
  });

  it('expands across the global store (a global seed reaches a global neighbour)', async () => {
    const glob = makeRoot('graphstream');
    try {
      const g = mem(glob, T, 'global seed');
      const gn = mem(glob, T, 'global neighbour');
      const eg = ent(glob, T, g, 'G');
      const egn = ent(glob, T, gn, 'GN');
      insertRelationAt(glob, T, { fromEntityId: eg, toEntityId: egn, relType: 'supersedes', memoryId: g.id });
      const entries = [g, gn];
      const out = await graphRankStream(entries, [seed(0)], {
        store: sqliteStore(home),
        tenantId: T,
        global: sqliteStore(glob),
      });
      expect(out).toEqual([1]);
    } finally {
      safeRmSync(glob);
    }
  });
});
