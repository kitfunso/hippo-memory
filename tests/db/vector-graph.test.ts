// The handwritten HNSW graph against an exact scan of the same vectors.
import { describe, it, expect, vi } from 'vitest';
import { mulberry32 } from '../_helpers/property.js';
import { createVectorGraph, insertNode, searchGraph, type VectorGraph } from '../../src/db/vector-graph.js';

// Some cases build two 3000-node graphs, which can pass the unit budget on a busy runner.
vi.setConfig({ testTimeout: 20_000 });

const DIM = 64;
const N = 3000;

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

function clustered(n: number, seed: number): Float32Array[] {
  const r = mulberry32(seed);
  const centres = Array.from({ length: n / 100 }, () =>
    Float32Array.from({ length: DIM }, () => gauss(r) / Math.sqrt(DIM)),
  );
  return Array.from({ length: n }, (_, i) => {
    const c = centres[i % centres.length];
    return Float32Array.from(c, (x) => x + ((gauss(r) * 0.15) / Math.sqrt(DIM)) * 1.0);
  });
}

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

function exactTop(vectors: Float32Array[], q: Float32Array, k: number, skip = new Set<number>()): number[] {
  const scored: { node: number; score: number }[] = [];
  vectors.forEach((v, node) => {
    if (!skip.has(node)) scored.push({ node, score: cosine(q, v) });
  });
  scored.sort((a, b) => b.score - a.score || a.node - b.node);
  return scored.slice(0, k).map((s) => s.node);
}

function build(vectors: Float32Array[], seed: number): VectorGraph {
  const g = createVectorGraph({ dim: DIM, m: 16, efConstruction: 100, seed });
  vectors.forEach((v, i) => insertNode(g, i, v));
  return g;
}

const vectors = clustered(N, 7);
const queries = Array.from({ length: 40 }, (_, i) => {
  const r = mulberry32(1000 + i);
  return Float32Array.from(vectors[(i * 73) % N], (x) => x + (gauss(r) * 0.1) / Math.sqrt(DIM));
});
const graph = build(vectors, 42);
const vectorOf = (n: number) => vectors[n];

function ids(
  g: VectorGraph,
  q: Float32Array,
  opts: { k: number; ef: number; admit?: (n: number) => boolean },
): number[] {
  const res = searchGraph(g, q, { ...opts, vectorOf });
  if (res.aborted) throw new Error('unexpected abort');
  return res.hits.map((h) => h.node);
}

describe('vector graph', () => {
  it('returns exactly the brute-force top 50 when ef covers every node', () => {
    for (const q of queries.slice(0, 5)) expect(ids(graph, q, { k: 50, ef: N })).toEqual(exactTop(vectors, q, 50));
  });

  it('reaches recall@50 of at least .98 at ef 128', () => {
    let hit = 0;
    for (const q of queries) {
      const truth = new Set(exactTop(vectors, q, 50));
      hit += ids(graph, q, { k: 50, ef: 128 }).filter((n) => truth.has(n)).length;
    }
    expect(hit / (queries.length * 50)).toBeGreaterThanOrEqual(0.98);
  });

  it('builds the same graph from the same seed and insert order', () => {
    const again = build(vectors, 42);
    expect(again.nodes).toEqual(graph.nodes);
    expect([again.entry, again.maxLevel, again.rng]).toEqual([graph.entry, graph.maxLevel, graph.rng]);
  });

  it('changes the graph when the seed changes', () => {
    const other = build(vectors.slice(0, 500), 43);
    const same = build(vectors.slice(0, 500), 42);
    expect(other.nodes).not.toEqual(same.nodes);
  });

  it('scores by its own unit vectors as it does by the vectors they came from', () => {
    for (const q of queries.slice(0, 10)) {
      const own = searchGraph(graph, q, { k: 50, ef: 128 });
      if (own.aborted) throw new Error('unexpected abort');
      expect(own.hits.map((h) => h.node)).toEqual(ids(graph, q, { k: 50, ef: 128 }));
    }
  });

  it('keeps a unit vector as given and copies any other', () => {
    const g = createVectorGraph({ dim: 2, seed: 1 });
    const unit = Float32Array.from([0.6, 0.8]);
    const long = Float32Array.from([3, 4]);
    insertNode(g, 0, unit);
    insertNode(g, 1, long);

    expect(g.unit.get(0)).toBe(unit);
    expect(g.unit.get(1)).not.toBe(long);
    expect(Array.from(g.unit.get(1) ?? [])).toEqual([Math.fround(0.6), Math.fround(0.8)]);
  });

  it('never returns a rejected node and still fills k', () => {
    for (const q of queries.slice(0, 5)) {
      const banned = new Set(exactTop(vectors, q, 20));
      const got = ids(graph, q, { k: 50, ef: 128, admit: (n) => !banned.has(n) });
      expect(got).toHaveLength(50);
      expect(got.some((n) => banned.has(n))).toBe(false);
    }
  });

  it('returns exactly the admitted brute-force top 50 when ef covers every node', () => {
    const q = queries[0];
    const banned = new Set(exactTop(vectors, q, 20));
    expect(ids(graph, q, { k: 50, ef: N, admit: (n) => !banned.has(n) })).toEqual(exactTop(vectors, q, 50, banned));
  });

  it('aborts when the visit budget runs out', () => {
    expect(searchGraph(graph, queries[0], { k: 50, ef: 128, visitBudget: 10, vectorOf })).toEqual({ aborted: true });
  });

  it('rejects a wrong dimension and a repeated node', () => {
    expect(() => insertNode(graph, 1, new Float32Array(3))).toThrow(/dim/);
    expect(() => insertNode(graph, 1, vectors[1])).toThrow(/already/);
  });
});
