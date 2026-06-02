/**
 * E3.2 multi-hop graph recall - engine + read-helper tests (real SQLite, no mocks).
 * Docs: docs/plans/2026-06-02-e3.2-multihop-recall.md
 *
 * Covers graphExpandRecall (seed mapping, N-hop BFS, bidirectional traversal, visited/
 * cycle safety, fanout cap, by-id load of reached memories with the recall hard filters
 * re-applied (superseded-drop / asOf — NOT lexical gating), budget bound, no-op gate,
 * tenant isolation, base-dedup) and the new graph.ts read helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { estimateTokens, type SearchResult } from '../src/search.js';
import {
  insertEntity,
  insertRelation,
  loadNeighborRelations,
  loadEntitiesByMemoryId,
  loadEntitiesByIds,
} from '../src/graph.js';
import { graphExpandRecall } from '../src/graph-recall.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-graphrecall-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
/** Write a distilled memory and return the full entry. Pads sub-3-char labels
 *  (createMemory enforces a 3-char minimum) while keeping them distinct. */
function mem(home: string, tenant: string, text: string): MemoryEntry {
  const content = text.length < 3 ? text.repeat(3) : text;
  const m = createMemory(content, { tags: [], layer: Layer.Semantic, confidence: 'verified', source: 'test', tenantId: tenant });
  writeEntry(home, m, { actor: 'test' });
  return m;
}
function sr(entry: MemoryEntry, score: number): SearchResult {
  return { entry, score, bm25: score, cosine: 0, tokens: estimateTokens(entry.content) };
}
/** Decision entity from a memory (entity_type 'decision' is in the enum). */
function ent(home: string, tenant: string, m: MemoryEntry, name: string): number {
  return insertEntity(home, tenant, { entityType: 'decision', name, memoryId: m.id }).id;
}

describe('E3.2 graph-recall engine', () => {
  let home: string;
  const T = 'default';
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => safeRmSync(home));

  it('1-hop surfaces a graph-linked neighbour the lexical search missed (loaded by id, not lexically gated)', () => {
    const a = mem(home, T, 'decision alpha about cache invalidation strategy');
    const b = mem(home, T, 'wholly unrelated wording xyzzy plugh frobnicate');
    const ea = ent(home, T, a, 'A');
    const eb = ent(home, T, b, 'B');
    insertRelation(home, T, { fromEntityId: eb, toEntityId: ea, relType: 'supersedes', memoryId: b.id });

    // base = only A (B is lexically orthogonal, would NOT be in any candidate set).
    const base = [sr(a, 1.0)];
    const out = graphExpandRecall(base, { hops: 1, hippoRoot: home, tenantId: T, budget: 4000 });

    const ids = out.map((r) => r.entry.id);
    expect(ids).toContain(b.id);
    const bHit = out.find((r) => r.entry.id === b.id)!;
    expect(bHit.graphVia).toEqual({ hops: 1, relType: 'supersedes', direction: 'from' });
    expect(out[0].entry.id).toBe(a.id); // base result stays first
  });

  it('--hops 2 reaches the 2-hop node; --hops 1 does not', () => {
    const a = mem(home, T, 'aaa'); const b = mem(home, T, 'bbb'); const c = mem(home, T, 'ccc');
    const ea = ent(home, T, a, 'A'); const eb = ent(home, T, b, 'B'); const ec = ent(home, T, c, 'C');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelation(home, T, { fromEntityId: eb, toEntityId: ec, relType: 'supersedes', memoryId: b.id });
    const base = [sr(a, 1.0)];

    // b and c are reached as the `to` endpoint of supersedes edges (superseded), so
    // --include-superseded is needed to surface them; this test is about hop-distance.
    const one = graphExpandRecall(base, { hops: 1, hippoRoot: home, tenantId: T, budget: 4000, includeSuperseded: true });
    expect(one.map((r) => r.entry.id)).toContain(b.id);
    expect(one.map((r) => r.entry.id)).not.toContain(c.id);

    const two = graphExpandRecall(base, { hops: 2, hippoRoot: home, tenantId: T, budget: 4000, includeSuperseded: true });
    expect(two.map((r) => r.entry.id)).toEqual(expect.arrayContaining([b.id, c.id]));
    expect(two.find((r) => r.entry.id === c.id)!.graphVia!.hops).toBe(2);
  });

  it('traverses bidirectionally (reaches a neighbour linked via to_entity_id)', () => {
    const seed = mem(home, T, 'seed'); const other = mem(home, T, 'other');
    const es = ent(home, T, seed, 'S'); const eo = ent(home, T, other, 'O');
    // Edge points O -> S; seed is the `to` endpoint. Traversal must still reach O.
    insertRelation(home, T, { fromEntityId: eo, toEntityId: es, relType: 'supersedes', memoryId: other.id });
    const out = graphExpandRecall([sr(seed, 1.0)], { hops: 1, hippoRoot: home, tenantId: T, budget: 4000 });
    const hit = out.find((r) => r.entry.id === other.id)!;
    expect(hit).toBeDefined();
    expect(hit.graphVia!.direction).toBe('from'); // O is the `from` endpoint reached from seed's `to` side
  });

  it('visited set makes a cycle terminate without double-counting', () => {
    const a = mem(home, T, 'a'); const b = mem(home, T, 'b');
    const ea = ent(home, T, a, 'A'); const eb = ent(home, T, b, 'B');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelation(home, T, { fromEntityId: eb, toEntityId: ea, relType: 'supersedes', memoryId: b.id });
    const out = graphExpandRecall([sr(a, 1.0)], { hops: 3, hippoRoot: home, tenantId: T, budget: 4000, includeSuperseded: true });
    expect(out.filter((r) => r.entry.id === b.id)).toHaveLength(1);
    expect(out).toHaveLength(2); // a (base) + b (reached once)
  });

  it('respects the per-hop maxNeighbors fanout cap', () => {
    const seed = mem(home, T, 'seed');
    const es = ent(home, T, seed, 'S');
    const neighbours = ['nn1', 'nn2', 'nn3', 'nn4', 'nn5'].map((n) => {
      const m = mem(home, T, n);
      const e = ent(home, T, m, n);
      insertRelation(home, T, { fromEntityId: es, toEntityId: e, relType: 'supersedes', memoryId: seed.id });
      return m;
    });
    const out = graphExpandRecall([sr(seed, 1.0)], {
      hops: 1, hippoRoot: home, tenantId: T, budget: 100000, maxNeighbors: 2, includeSuperseded: true,
    });
    expect(out.filter((r) => r.graphVia).length).toBe(2);
    // sanity: all 5 neighbours exist, only 2 surfaced
    expect(neighbours).toHaveLength(5);
  });

  it('drops a reached SUPERSEDED memory unless --include-superseded', () => {
    const a = mem(home, T, 'active head decision');
    const old = mem(home, T, 'older superseded predecessor');
    // Mark `old` superseded (point it at `a`).
    old.superseded_by = a.id;
    writeEntry(home, old, { actor: 'test' });
    const ea = ent(home, T, a, 'A'); const eo = ent(home, T, old, 'OLD');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eo, relType: 'supersedes', memoryId: a.id });
    const base = [sr(a, 1.0)];

    const dflt = graphExpandRecall(base, { hops: 1, hippoRoot: home, tenantId: T, budget: 4000 });
    expect(dflt.map((r) => r.entry.id)).not.toContain(old.id); // superseded dropped by default

    const incl = graphExpandRecall(base, { hops: 1, hippoRoot: home, tenantId: T, budget: 4000, includeSuperseded: true });
    expect(incl.map((r) => r.entry.id)).toContain(old.id); // surfaced when requested
  });

  it('graph-edge superseded semantics: the newer (from) endpoint shows by default; the older (to) endpoint needs --include-superseded (codex P2)', () => {
    // old <- new : insertRelation(from=new, to=old) means "new supersedes old".
    const oldD = mem(home, T, 'the older decision we moved on from');
    const newD = mem(home, T, 'the current decision in force');
    const eo = ent(home, T, oldD, 'OLD'); const en = ent(home, T, newD, 'NEW');
    insertRelation(home, T, { fromEntityId: en, toEntityId: eo, relType: 'supersedes', memoryId: newD.id });

    // Seed = the OLD decision (lexical hit). --hops reaches NEW as the `from` endpoint
    // (the current version) -> shown by DEFAULT (no --include-superseded).
    const fromOld = graphExpandRecall([sr(oldD, 1.0)], { hops: 1, hippoRoot: home, tenantId: T, budget: 4000 });
    expect(fromOld.map((r) => r.entry.id)).toContain(newD.id);
    expect(fromOld.find((r) => r.entry.id === newD.id)!.graphVia!.direction).toBe('from');

    // Seed = the NEW decision. --hops reaches OLD as the `to` endpoint (superseded) ->
    // DROPPED by default, surfaced only with --include-superseded.
    const fromNewDefault = graphExpandRecall([sr(newD, 1.0)], { hops: 1, hippoRoot: home, tenantId: T, budget: 4000 });
    expect(fromNewDefault.map((r) => r.entry.id)).not.toContain(oldD.id);
    const fromNewIncl = graphExpandRecall([sr(newD, 1.0)], { hops: 1, hippoRoot: home, tenantId: T, budget: 4000, includeSuperseded: true });
    expect(fromNewIncl.map((r) => r.entry.id)).toContain(oldD.id);
  });

  it('asOf drops a reached memory whose valid_from is after the as-of date', () => {
    const a = mem(home, T, 'seed decision');
    const future = mem(home, T, 'a future-dated linked decision');
    const ea = ent(home, T, a, 'A'); const ef = ent(home, T, future, 'F');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: ef, relType: 'supersedes', memoryId: a.id });
    // future.valid_from is "now"; ask as-of a date in the past -> it must be dropped.
    const out = graphExpandRecall([sr(a, 1.0)], { hops: 1, hippoRoot: home, tenantId: T, budget: 4000, asOf: '2000-01-01' });
    expect(out.map((r) => r.entry.id)).not.toContain(future.id);
    expect(out).toHaveLength(1);
  });

  it('asOf applies the FULL bi-temporal rule: a superseded reached row is dropped once its successor was valid as-of (codex P2)', () => {
    const seed = mem(home, T, 'current head decision');
    const pred = mem(home, T, 'the predecessor decision lineage');
    pred.valid_from = '2020-01-01T00:00:00.000Z';
    pred.superseded_by = seed.id;
    writeEntry(home, pred, { actor: 'test' });
    // seed (the successor) became valid 2021-01-01.
    seed.valid_from = '2021-01-01T00:00:00.000Z';
    writeEntry(home, seed, { actor: 'test' });
    const es = ent(home, T, seed, 'S'); const ep = ent(home, T, pred, 'P');
    insertRelation(home, T, { fromEntityId: es, toEntityId: ep, relType: 'supersedes', memoryId: seed.id });

    // as-of AFTER the successor became valid -> the predecessor is no longer the valid
    // version, must be DROPPED (not merely valid_from <= asOf).
    const after = graphExpandRecall([sr(seed, 1.0)], { hops: 1, hippoRoot: home, tenantId: T, budget: 4000, asOf: '2022-01-01' });
    expect(after.map((r) => r.entry.id)).not.toContain(pred.id);

    // as-of BEFORE the successor became valid -> the predecessor WAS the valid version,
    // must be surfaced.
    const before = graphExpandRecall([sr(seed, 1.0)], { hops: 1, hippoRoot: home, tenantId: T, budget: 4000, asOf: '2020-06-01' });
    expect(before.map((r) => r.entry.id)).toContain(pred.id);
  });

  it('expands the GLOBAL store too: a seed whose graph lives in globalRoot surfaces its neighbour (codex P2)', () => {
    const glob = makeRoot();
    try {
      // The seed + its graph live in the GLOBAL store; the local store has no entities.
      const seed = mem(glob, T, 'globally-stored seed decision');
      const linked = mem(glob, T, 'a globally-stored linked predecessor');
      const es = ent(glob, T, seed, 'S'); const el = ent(glob, T, linked, 'L');
      insertRelation(glob, T, { fromEntityId: es, toEntityId: el, relType: 'supersedes', memoryId: seed.id });
      const out = graphExpandRecall([sr(seed, 1.0)], { hops: 1, hippoRoot: home, globalRoot: glob, tenantId: T, budget: 4000, includeSuperseded: true });
      expect(out.map((r) => r.entry.id)).toContain(linked.id);
      expect(out.find((r) => r.entry.id === linked.id)!.graphVia).toBeDefined();
    } finally {
      safeRmSync(glob);
    }
  });

  it('--hops 0 is a no-op (identity)', () => {
    const a = mem(home, T, 'a');
    const base = [sr(a, 1.0)];
    expect(graphExpandRecall(base, { hops: 0, hippoRoot: home, tenantId: T, budget: 4000 })).toBe(base);
  });

  it('empty graph is a no-op (no throw)', () => {
    const a = mem(home, T, 'a');
    const base = [sr(a, 1.0)];
    const out = graphExpandRecall(base, { hops: 2, hippoRoot: home, tenantId: T, budget: 4000 });
    expect(out).toBe(base); // no seed entity -> unchanged reference
  });

  it('token budget bounds the augmented set', () => {
    const a = mem(home, T, 'short');
    const big = mem(home, T, 'x'.repeat(8000)); // ~2000 tokens
    const ea = ent(home, T, a, 'A'); const eb = ent(home, T, big, 'B');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    // Budget already nearly consumed by the base entry; the big neighbour overflows it.
    // includeSuperseded so the exclusion under test is the BUDGET, not the superseded-endpoint drop.
    const out = graphExpandRecall([sr(a, 1.0)], { hops: 1, hippoRoot: home, tenantId: T, budget: 10, includeSuperseded: true });
    expect(out.map((r) => r.entry.id)).not.toContain(big.id);
  });

  it('does not duplicate a neighbour already present in the base results (it stays a seed, untouched)', () => {
    const a = mem(home, T, 'a'); const b = mem(home, T, 'b');
    const ea = ent(home, T, a, 'A'); const eb = ent(home, T, b, 'B');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    const base = [sr(a, 1.0), sr(b, 0.9)]; // b already returned lexically -> it is a seed too
    const out = graphExpandRecall(base, { hops: 1, hippoRoot: home, tenantId: T, budget: 4000 });
    expect(out.filter((r) => r.entry.id === b.id)).toHaveLength(1);
    expect(out.find((r) => r.entry.id === b.id)!.graphVia).toBeUndefined(); // already-present neighbour left as-is
  });

  it('never reaches another tenant\'s entity', () => {
    const a = mem(home, T, 'a');
    const aOther = mem(home, 'other', 'other-tenant');
    const ea = ent(home, T, a, 'A');
    const eo = ent(home, 'other', aOther, 'O');
    // A cross-tenant relation cannot be inserted (insertRelation rejects it), so the
    // graphs are disjoint by construction. Expanding tenant T must not surface 'other'.
    expect(() => insertRelation(home, T, { fromEntityId: ea, toEntityId: eo, relType: 'supersedes', memoryId: a.id }))
      .toThrow(/another tenant/i);
    const out = graphExpandRecall([sr(a, 1.0)], { hops: 2, hippoRoot: home, tenantId: T, budget: 4000 });
    expect(out.map((r) => r.entry.id)).not.toContain(aOther.id);
  });
});

describe('E3.2 graph.ts read helpers', () => {
  let home: string;
  const T = 'default';
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => safeRmSync(home));

  it('loadEntitiesByMemoryId maps source memory ids to entities (hit + miss)', () => {
    const a = mem(home, T, 'a');
    const ea = ent(home, T, a, 'A');
    const got = loadEntitiesByMemoryId(home, T, [a.id, 'nonexistent']);
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe(ea);
    expect(loadEntitiesByMemoryId(home, T, [])).toEqual([]);
  });

  it('loadEntitiesByIds resolves reached entity rows by id', () => {
    const a = mem(home, T, 'a'); const b = mem(home, T, 'b');
    const ea = ent(home, T, a, 'A'); const eb = ent(home, T, b, 'B');
    const got = loadEntitiesByIds(home, T, [ea, eb]).sort((x, y) => x.id - y.id);
    expect(got.map((e) => e.id)).toEqual([ea, eb].sort((x, y) => x - y));
  });

  it('loadNeighborRelations returns edges in BOTH directions for the frontier', () => {
    const a = mem(home, T, 'a'); const b = mem(home, T, 'b'); const c = mem(home, T, 'c');
    const ea = ent(home, T, a, 'A'); const eb = ent(home, T, b, 'B'); const ec = ent(home, T, c, 'C');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id }); // A->B
    insertRelation(home, T, { fromEntityId: ec, toEntityId: ea, relType: 'supersedes', memoryId: c.id }); // C->A
    const rels = loadNeighborRelations(home, T, [ea]); // touches A as from (A->B) and as to (C->A)
    expect(rels).toHaveLength(2);
  });

  it('loadNeighborRelations rejects a non-integer limit (guards the raw LIMIT ?)', () => {
    const a = mem(home, T, 'a'); const ea = ent(home, T, a, 'A');
    expect(() => loadNeighborRelations(home, T, [ea], { limit: 1.5 })).toThrow(/non-negative integer/);
    expect(() => loadNeighborRelations(home, T, [ea], { limit: -1 })).toThrow(/non-negative integer/);
  });
});
