// Handwritten HNSW graph (Malkov and Yashunin) over plain data: no database, no I/O. Same seed and insert order give
// the same graph.

import { stepMulberry32 } from '../base/util/prng.js';

export interface VectorGraphOptions {
  dim: number;
  m?: number;
  efConstruction?: number;
  seed: number;
}

interface GraphNodeData {
  level: number;
  links: number[][];
}

export interface VectorGraph {
  readonly dim: number;
  readonly m: number;
  readonly efConstruction: number;
  readonly seed: number;
  rng: number;
  entry: number;
  maxLevel: number;
  readonly nodes: Map<number, GraphNodeData>;
  // The unit-length vector of every node.
  readonly unit: Map<number, Float32Array>;
}

export interface SearchOptions {
  k: number;
  ef: number;
  /** Checked for every candidate before it can enter the result; a rejected node is still walked through. */
  admit?: (node: number) => boolean;
  /** Most vectors the walk may score; past it the search stops with `aborted`. */
  visitBudget?: number;
  /** The vector a node is scored by; the graph's own unit vectors when omitted. */
  vectorOf?: VectorLookup;
}

export interface GraphHit {
  node: number;
  score: number;
}

export type SearchResult = { aborted: false; hits: GraphHit[] } | { aborted: true };

type VectorLookup = (node: number) => Float32Array;

const MAX_LEVEL = 15;
// Float32 rounding leaves a normalised vector's squared length within about 1e-6 of one.
const UNIT_TOLERANCE = 1e-5;

export function createVectorGraph(opts: VectorGraphOptions): VectorGraph {
  const { dim, m = 16, efConstruction = 200, seed } = opts;
  if (!Number.isInteger(dim) || dim < 1) throw new Error(`vector graph: bad dim ${dim}`);
  if (!Number.isInteger(m) || m < 2) throw new Error(`vector graph: bad m ${m}`);
  return { dim, m, efConstruction, seed, rng: seed >>> 0, entry: -1, maxLevel: -1, nodes: new Map(), unit: new Map() };
}

function nextRandom(graph: VectorGraph): number {
  const step = stepMulberry32(graph.rng);
  graph.rng = step.state;
  return step.value;
}

class Heap {
  private readonly keys: number[] = [];
  private readonly vals: number[] = [];
  // sign 1 pops the largest key first, -1 the smallest.
  constructor(private readonly sign: 1 | -1) {}
  get size(): number {
    return this.keys.length;
  }
  peekKey(): number {
    return this.keys[0];
  }
  push(key: number, val: number): void {
    const { keys, vals, sign } = this;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (sign * keys[p] >= sign * key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  pop(): GraphHit {
    const { keys, vals, sign } = this;
    const top = { score: keys[0], node: vals[0] };
    const lastKey = keys.pop() ?? 0;
    const lastVal = vals.pop() ?? 0;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && sign * keys[c + 1] > sign * keys[c]) c++;
        if (sign * keys[c] <= sign * lastKey) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = lastKey;
      vals[i] = lastVal;
    }
    return top;
  }
}

// Four running sums, which V8 runs faster than one: inserts spend most of their time here.
function dot(a: Float32Array, b: Float32Array): number {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  const whole = a.length & ~3;
  let i = 0;
  for (; i < whole; i += 4) {
    s0 += a[i] * b[i];
    s1 += a[i + 1] * b[i + 1];
    s2 += a[i + 2] * b[i + 2];
    s3 += a[i + 3] * b[i + 3];
  }
  for (; i < a.length; i++) s0 += a[i] * b[i];
  return s0 + s1 + (s2 + s3);
}

function normOf(v: Float32Array): number {
  return Math.sqrt(dot(v, v));
}

function toUnit(v: Float32Array): Float32Array {
  const n = normOf(v);
  if (n < 1e-10) return new Float32Array(v.length);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// Same arithmetic as rankVectorRows in src/db/vector-store.ts: float64 sums, zero-norm rows score 0.
function cosine(q: Float32Array, qNorm: number, v: Float32Array): number {
  let d = 0;
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    d += q[i] * v[i];
    n += v[i] * v[i];
  }
  return n < 1e-20 || qNorm < 1e-10 ? 0 : d / (qNorm * Math.sqrt(n));
}

interface WalkContext {
  graph: VectorGraph;
  score: (node: number) => number;
  admit?: (node: number) => boolean;
  /** Vectors still allowed to be scored, shared by every layer of one search; negative means no budget. */
  budget: { left: number };
}

/** Best-first walk of one layer: the ef best admitted candidates, best first, or null when the budget ran out. */
function searchLayer(ctx: WalkContext, entries: GraphHit[], ef: number, level: number): GraphHit[] | null {
  const visited = new Set<number>();
  const frontier = new Heap(1);
  const result = new Heap(-1);
  for (const e of entries) {
    visited.add(e.node);
    frontier.push(e.score, e.node);
    if (!ctx.admit || ctx.admit(e.node)) result.push(e.score, e.node);
  }
  while (frontier.size > 0) {
    const cur = frontier.pop();
    if (result.size >= ef && cur.score < result.peekKey()) break;
    const links = ctx.graph.nodes.get(cur.node)?.links[level] ?? [];
    for (const n of links) {
      if (visited.has(n) || !ctx.graph.nodes.has(n)) continue;
      visited.add(n);
      if (ctx.budget.left === 0) return null;
      if (ctx.budget.left > 0) ctx.budget.left--;
      const s = ctx.score(n);
      if (result.size < ef || s > result.peekKey()) {
        frontier.push(s, n);
        if (!ctx.admit || ctx.admit(n)) {
          result.push(s, n);
          if (result.size > ef) result.pop();
        }
      }
    }
  }
  const out: GraphHit[] = [];
  while (result.size > 0) out.push(result.pop());
  return out.reverse();
}

/** Walk down from the entry through the upper layers (ef 1, no filter) and return the entries for layer `stop`. */
function descend(ctx: WalkContext, stop: number): GraphHit[] | null {
  const { graph } = ctx;
  let cur: GraphHit[] = [{ node: graph.entry, score: ctx.score(graph.entry) }];
  for (let l = graph.maxLevel; l > stop; l--) {
    const next = searchLayer(ctx, cur, 1, l);
    if (!next) return null;
    cur = next;
  }
  return cur;
}

export function searchGraph(graph: VectorGraph, query: Float32Array, opts: SearchOptions): SearchResult {
  if (graph.entry < 0 || opts.k <= 0 || query.length !== graph.dim) return { aborted: false, hits: [] };
  const qNorm = normOf(query);
  const vectorOf = opts.vectorOf ?? ((n: number) => unitOf(graph, n));
  const seen = new Map<number, boolean>();
  const admit = opts.admit;
  const memo = admit
    ? (n: number): boolean => {
        const known = seen.get(n);
        if (known !== undefined) return known;
        const ok = admit(n);
        seen.set(n, ok);
        return ok;
      }
    : undefined;
  const ctx: WalkContext = {
    graph,
    score: (n) => cosine(query, qNorm, vectorOf(n)),
    admit: memo,
    budget: { left: opts.visitBudget ?? -1 },
  };
  const entry = descend({ ...ctx, admit: undefined }, 0);
  if (!entry) return { aborted: true };
  const found = searchLayer(ctx, entry, Math.max(opts.ef, opts.k), 0);
  if (!found) return { aborted: true };
  found.sort((a, b) => b.score - a.score || a.node - b.node);
  return { aborted: false, hits: found.slice(0, opts.k) };
}

function unitOf(graph: VectorGraph, node: number): Float32Array {
  const unit = graph.unit.get(node);
  if (!unit) throw new Error(`vector graph: no vector for node ${node}`);
  return unit;
}

/** Algorithm 4 without extendCandidates or keepPrunedConnections; `cands` must be sorted best first. */
function selectNeighbours(cands: GraphHit[], m: number, unitFor: VectorLookup): number[] {
  const kept: number[] = [];
  for (const c of cands) {
    if (kept.length >= m) break;
    const cu = unitFor(c.node);
    if (kept.every((r) => dot(cu, unitFor(r)) <= c.score)) kept.push(c.node);
  }
  return kept;
}

function addBackLink(graph: VectorGraph, from: number, to: number, level: number, unitFor: VectorLookup): void {
  const data = graph.nodes.get(from);
  if (!data) return;
  const cap = level === 0 ? 2 * graph.m : graph.m;
  const cur = data.links[level];
  if (cur.length < cap) {
    cur.push(to);
    return;
  }
  const fu = unitFor(from);
  const cands = [...cur, to].map((node) => ({ node, score: dot(fu, unitFor(node)) }));
  cands.sort((a, b) => b.score - a.score || a.node - b.node);
  data.links[level] = selectNeighbours(cands, cap, unitFor);
}

// Only a search with a visit budget can return null, and an insert sets none.
function unreachable(): never {
  throw new Error('vector graph: insert walk ran out of budget');
}

/** Add one node. A vector already of unit length is kept as given, not copied, so the caller must not change it. */
export function insertNode(graph: VectorGraph, node: number, vector: Float32Array): void {
  if (vector.length !== graph.dim) throw new Error(`vector graph: expected dim ${graph.dim}, got ${vector.length}`);
  if (graph.nodes.has(node)) throw new Error(`vector graph: node ${node} already inserted`);
  const q = Math.abs(dot(vector, vector) - 1) < UNIT_TOLERANCE ? vector : toUnit(vector);
  const level = Math.min(MAX_LEVEL, Math.floor(-Math.log(1 - nextRandom(graph)) / Math.log(graph.m)));
  graph.unit.set(node, q);
  const data: GraphNodeData = { level, links: Array.from({ length: level + 1 }, () => []) };
  if (graph.entry < 0) {
    graph.nodes.set(node, data);
    graph.entry = node;
    graph.maxLevel = level;
    return;
  }
  const unitFor = (n: number) => unitOf(graph, n);
  const ctx: WalkContext = { graph, score: (n) => dot(q, unitFor(n)), budget: { left: -1 } };
  let entries = descend(ctx, level) ?? unreachable();
  for (let l = Math.min(level, graph.maxLevel); l >= 0; l--) {
    const found = searchLayer(ctx, entries, graph.efConstruction, l) ?? unreachable();
    data.links[l] = selectNeighbours(found, graph.m, unitFor);
    entries = found;
  }
  graph.nodes.set(node, data);
  for (let l = 0; l <= Math.min(level, graph.maxLevel); l++) {
    for (const n of data.links[l]) addBackLink(graph, n, node, l, unitFor);
  }
  if (level > graph.maxLevel) {
    graph.maxLevel = level;
    graph.entry = node;
  }
}
