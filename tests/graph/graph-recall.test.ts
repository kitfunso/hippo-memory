import { describe, it, expect, beforeEach } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { estimateTokens } from '../../src/base/util/token-text.js';
import type { SearchResult } from '../../src/base/rank/search-types.js';
import { insertEntityAt, insertRelationAt } from '../_helpers/graph-seed.js';
import { graphExpandRecall } from '../../src/domain/graph/recall.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEntitiesByMemoryId, loadNeighborRelations, loadEntitiesByIds } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, sqliteStore } = sessionPerTest();

function safeRmSync(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
  }
}
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
function sr(entry: MemoryEntry, score: number): SearchResult {
  return { entry, score, bm25: score, cosine: 0, tokens: estimateTokens(entry.content) };
}
function ent(home: string, tenant: string, m: MemoryEntry, name: string): number {
  return insertEntityAt(home, tenant, { entityType: 'decision', name, memoryId: m.id }).id;
}

describe('graph-recall engine', () => {
  let home: string;
  const T = 'default';
  beforeEach(() => {
    home = makeRoot('graphrecall');
  });

  it('1-hop surfaces a graph-linked neighbour the lexical search missed (loaded by id, not lexically gated)', async () => {
    const a = mem(home, T, 'decision alpha about cache invalidation strategy');
    const b = mem(home, T, 'wholly unrelated wording xyzzy plugh frobnicate');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    insertRelationAt(home, T, { fromEntityId: eb, toEntityId: ea, relType: 'supersedes', memoryId: b.id });

    const base = [sr(a, 1.0)];
    const out = await graphExpandRecall(base, { hops: 1, store: sqliteStore(home), tenantId: T, budget: 4000 });

    const ids = out.map((r) => r.entry.id);
    expect(ids).toContain(b.id);
    const bHit = out.find((r) => r.entry.id === b.id)!;
    expect(bHit.graphVia).toEqual({ hops: 1, relType: 'supersedes', direction: 'from' });
    expect(out[0].entry.id).toBe(a.id);
  });

  it('--hops 2 reaches the 2-hop node; --hops 1 does not', async () => {
    const a = mem(home, T, 'aaa');
    const b = mem(home, T, 'bbb');
    const c = mem(home, T, 'ccc');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    const ec = ent(home, T, c, 'C');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelationAt(home, T, { fromEntityId: eb, toEntityId: ec, relType: 'supersedes', memoryId: b.id });
    const base = [sr(a, 1.0)];

    const one = await graphExpandRecall(base, {
      hops: 1,
      store: sqliteStore(home),
      tenantId: T,
      budget: 4000,
      includeSuperseded: true,
    });
    expect(one.map((r) => r.entry.id)).toContain(b.id);
    expect(one.map((r) => r.entry.id)).not.toContain(c.id);

    const two = await graphExpandRecall(base, {
      hops: 2,
      store: sqliteStore(home),
      tenantId: T,
      budget: 4000,
      includeSuperseded: true,
    });
    expect(two.map((r) => r.entry.id)).toEqual(expect.arrayContaining([b.id, c.id]));
    expect(two.find((r) => r.entry.id === c.id)!.graphVia!.hops).toBe(2);
  });

  it('traverses bidirectionally (reaches a neighbour linked via to_entity_id)', async () => {
    const seed = mem(home, T, 'seed');
    const other = mem(home, T, 'other');
    const es = ent(home, T, seed, 'S');
    const eo = ent(home, T, other, 'O');
    insertRelationAt(home, T, { fromEntityId: eo, toEntityId: es, relType: 'supersedes', memoryId: other.id });
    const out = await graphExpandRecall([sr(seed, 1.0)], {
      hops: 1,
      store: sqliteStore(home),
      tenantId: T,
      budget: 4000,
    });
    const hit = out.find((r) => r.entry.id === other.id)!;
    expect(hit.graphVia!.direction).toBe('from');
  });

  it('visited set makes a cycle terminate without double-counting', async () => {
    const a = mem(home, T, 'a');
    const b = mem(home, T, 'b');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelationAt(home, T, { fromEntityId: eb, toEntityId: ea, relType: 'supersedes', memoryId: b.id });
    const out = await graphExpandRecall([sr(a, 1.0)], {
      hops: 3,
      store: sqliteStore(home),
      tenantId: T,
      budget: 4000,
      includeSuperseded: true,
    });
    expect(out.filter((r) => r.entry.id === b.id)).toHaveLength(1);
    expect(out).toHaveLength(2);
  });

  it('respects the per-hop maxNeighbors fanout cap', async () => {
    const seed = mem(home, T, 'seed');
    const es = ent(home, T, seed, 'S');
    const neighbors = ['nn1', 'nn2', 'nn3', 'nn4', 'nn5'].map((n) => {
      const m = mem(home, T, n);
      const e = ent(home, T, m, n);
      insertRelationAt(home, T, { fromEntityId: es, toEntityId: e, relType: 'supersedes', memoryId: seed.id });
      return m;
    });
    const out = await graphExpandRecall([sr(seed, 1.0)], {
      hops: 1,
      store: sqliteStore(home),
      tenantId: T,
      budget: 100000,
      maxNeighbors: 2,
      includeSuperseded: true,
    });
    expect(out.filter((r) => r.graphVia).length).toBe(2);
    expect(neighbors).toHaveLength(5);
  });

  it('drops a reached SUPERSEDED memory unless --include-superseded', async () => {
    const a = mem(home, T, 'active head decision');
    const old = mem(home, T, 'older superseded predecessor');
    old.supersededBy = a.id;
    writeEntry(home, old, { actor: 'test' });
    const ea = ent(home, T, a, 'A');
    const eo = ent(home, T, old, 'OLD');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eo, relType: 'supersedes', memoryId: a.id });
    const base = [sr(a, 1.0)];

    const dflt = await graphExpandRecall(base, { hops: 1, store: sqliteStore(home), tenantId: T, budget: 4000 });
    expect(dflt.map((r) => r.entry.id)).not.toContain(old.id);

    const incl = await graphExpandRecall(base, {
      hops: 1,
      store: sqliteStore(home),
      tenantId: T,
      budget: 4000,
      includeSuperseded: true,
    });
    expect(incl.map((r) => r.entry.id)).toContain(old.id);
  });

  it('graph-edge superseded semantics: the newer (from) endpoint shows by default; the older (to) endpoint needs --include-superseded', async () => {
    const oldD = mem(home, T, 'the older decision we moved on from');
    const newD = mem(home, T, 'the current decision in force');
    const eo = ent(home, T, oldD, 'OLD');
    const en = ent(home, T, newD, 'NEW');
    insertRelationAt(home, T, { fromEntityId: en, toEntityId: eo, relType: 'supersedes', memoryId: newD.id });

    const fromOld = await graphExpandRecall([sr(oldD, 1.0)], {
      hops: 1,
      store: sqliteStore(home),
      tenantId: T,
      budget: 4000,
    });
    expect(fromOld.map((r) => r.entry.id)).toContain(newD.id);
    expect(fromOld.find((r) => r.entry.id === newD.id)!.graphVia!.direction).toBe('from');

    const fromNewDefault = await graphExpandRecall([sr(newD, 1.0)], {
      hops: 1,
      store: sqliteStore(home),
      tenantId: T,
      budget: 4000,
    });
    expect(fromNewDefault.map((r) => r.entry.id)).not.toContain(oldD.id);
    const fromNewIncl = await graphExpandRecall([sr(newD, 1.0)], {
      hops: 1,
      store: sqliteStore(home),
      tenantId: T,
      budget: 4000,
      includeSuperseded: true,
    });
    expect(fromNewIncl.map((r) => r.entry.id)).toContain(oldD.id);
  });

  it('asOf drops a reached memory whose valid_from is after the as-of date', async () => {
    const a = mem(home, T, 'seed decision');
    const future = mem(home, T, 'a future-dated linked decision');
    const ea = ent(home, T, a, 'A');
    const ef = ent(home, T, future, 'F');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: ef, relType: 'supersedes', memoryId: a.id });
    const out = await graphExpandRecall([sr(a, 1.0)], {
      hops: 1,
      store: sqliteStore(home),
      tenantId: T,
      budget: 4000,
      asOf: '2000-01-01',
    });
    expect(out.map((r) => r.entry.id)).not.toContain(future.id);
    expect(out).toHaveLength(1);
  });

  it('asOf applies the FULL bi-temporal rule: a superseded reached row is dropped once its successor was valid as-of', async () => {
    const seed = mem(home, T, 'current head decision');
    const pred = mem(home, T, 'the predecessor decision lineage');
    pred.validFrom = '2020-01-01T00:00:00.000Z';
    pred.supersededBy = seed.id;
    writeEntry(home, pred, { actor: 'test' });
    seed.validFrom = '2021-01-01T00:00:00.000Z';
    writeEntry(home, seed, { actor: 'test' });
    const es = ent(home, T, seed, 'S');
    const ep = ent(home, T, pred, 'P');
    insertRelationAt(home, T, { fromEntityId: es, toEntityId: ep, relType: 'supersedes', memoryId: seed.id });

    const after = await graphExpandRecall([sr(seed, 1.0)], {
      hops: 1,
      store: sqliteStore(home),
      tenantId: T,
      budget: 4000,
      asOf: '2022-01-01',
    });
    expect(after.map((r) => r.entry.id)).not.toContain(pred.id);

    const before = await graphExpandRecall([sr(seed, 1.0)], {
      hops: 1,
      store: sqliteStore(home),
      tenantId: T,
      budget: 4000,
      asOf: '2020-06-01',
    });
    expect(before.map((r) => r.entry.id)).toContain(pred.id);
  });

  it('expands the GLOBAL store too: a seed whose graph lives in globalRoot surfaces its neighbour', async () => {
    const glob = makeRoot('graphrecall');
    try {
      const seed = mem(glob, T, 'globally-stored seed decision');
      const linked = mem(glob, T, 'a globally-stored linked predecessor');
      const es = ent(glob, T, seed, 'S');
      const el = ent(glob, T, linked, 'L');
      insertRelationAt(glob, T, { fromEntityId: es, toEntityId: el, relType: 'supersedes', memoryId: seed.id });
      const out = await graphExpandRecall([sr(seed, 1.0)], {
        hops: 1,
        store: sqliteStore(home),
        global: sqliteStore(glob),
        tenantId: T,
        budget: 4000,
        includeSuperseded: true,
      });
      expect(out.map((r) => r.entry.id)).toContain(linked.id);
      expect(out.find((r) => r.entry.id === linked.id)?.graphVia).toMatchObject({ hops: 1, relType: 'supersedes' });
    } finally {
      safeRmSync(glob);
    }
  });

  it('--hops 0 is a no-op (identity)', async () => {
    const a = mem(home, T, 'a');
    const base = [sr(a, 1.0)];
    expect(await graphExpandRecall(base, { hops: 0, store: sqliteStore(home), tenantId: T, budget: 4000 })).toBe(base);
  });

  it('empty graph is a no-op (no throw)', async () => {
    const a = mem(home, T, 'a');
    const base = [sr(a, 1.0)];
    const out = await graphExpandRecall(base, { hops: 2, store: sqliteStore(home), tenantId: T, budget: 4000 });
    expect(out).toBe(base);
  });

  it('token budget bounds the augmented set', async () => {
    const a = mem(home, T, 'short');
    const big = mem(home, T, 'x'.repeat(8000));
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, big, 'B');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    const out = await graphExpandRecall([sr(a, 1.0)], {
      hops: 1,
      store: sqliteStore(home),
      tenantId: T,
      budget: 10,
      includeSuperseded: true,
    });
    expect(out.map((r) => r.entry.id)).not.toContain(big.id);
  });

  it('does not duplicate a neighbour already present in the base results (it stays a seed, untouched)', async () => {
    const a = mem(home, T, 'a');
    const b = mem(home, T, 'b');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    const base = [sr(a, 1.0), sr(b, 0.9)];
    const out = await graphExpandRecall(base, { hops: 1, store: sqliteStore(home), tenantId: T, budget: 4000 });
    expect(out.filter((r) => r.entry.id === b.id)).toHaveLength(1);
    expect(out.find((r) => r.entry.id === b.id)!.graphVia).toBeUndefined();
  });

  it("never reaches another tenant's entity", async () => {
    const a = mem(home, T, 'a');
    const aOther = mem(home, 'other', 'other-tenant');
    const ea = ent(home, T, a, 'A');
    const eo = ent(home, 'other', aOther, 'O');
    expect(() =>
      insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eo, relType: 'supersedes', memoryId: a.id }),
    ).toThrow(/another tenant/i);
    const out = await graphExpandRecall([sr(a, 1.0)], { hops: 2, store: sqliteStore(home), tenantId: T, budget: 4000 });
    expect(out.map((r) => r.entry.id)).not.toContain(aOther.id);
  });
});

describe('graph.ts read helpers', () => {
  let home: string;
  const T = 'default';
  beforeEach(() => {
    home = makeRoot('graphrecall');
  });

  it('loadEntitiesByMemoryId maps source memory ids to entities (hit + miss)', async () => {
    const a = mem(home, T, 'a');
    const ea = ent(home, T, a, 'A');
    const got = await loadEntitiesByMemoryId(home, T, [a.id, 'nonexistent']);
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe(ea);
    expect(await loadEntitiesByMemoryId(home, T, [])).toEqual([]);
  });

  it('loadEntitiesByIds resolves reached entity rows by id', async () => {
    const a = mem(home, T, 'a');
    const b = mem(home, T, 'b');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    const got = (await loadEntitiesByIds(home, T, [ea, eb])).sort((x, y) => x.id - y.id);
    expect(got.map((e) => e.id)).toEqual([ea, eb].sort((x, y) => x - y));
  });

  it('loadNeighborRelations returns edges in BOTH directions for the frontier', async () => {
    const a = mem(home, T, 'a');
    const b = mem(home, T, 'b');
    const c = mem(home, T, 'c');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    const ec = ent(home, T, c, 'C');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelationAt(home, T, { fromEntityId: ec, toEntityId: ea, relType: 'supersedes', memoryId: c.id });
    const rels = await loadNeighborRelations(home, T, [ea]);
    expect(rels).toHaveLength(2);
  });

  it('loadNeighborRelations rejects a non-integer limit (guards the raw LIMIT ?)', async () => {
    const a = mem(home, T, 'a');
    const ea = ent(home, T, a, 'A');
    await expect(loadNeighborRelations(home, T, [ea], { limit: 1.5 })).rejects.toThrow(/non-negative integer/);
    await expect(loadNeighborRelations(home, T, [ea], { limit: -1 })).rejects.toThrow(/non-negative integer/);
  });
});
