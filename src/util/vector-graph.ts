// Handwritten HNSW graph (Malkov and Yashunin) over plain data: no database, no I/O. Slice 2 persists the lists and
// supplies vectors: `vectorsOf` a batch per expanded node on search. Same seed and insert order give the same graph.

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
  // Unit-length copies of vectors inserted or read through vectorOf in this process; a restored graph starts empty.
  readonly unit: Map<number, Float32Array>;
}

export interface GraphMeta {
  dim: number;
  m: number;
  efConstruction: number;
  seed: number;
  rng: number;
  entry: number;
  maxLevel: number;
}

export interface GraphNode {
  node: number;
  level: number;
  neighbours: Uint32Array[];
}

export interface SearchOptions {
  k: number;
  ef: number;
  /** Checked for every candidate before it can enter the result; a rejected node is still walked through. */
  admit?: (node: number) => boolean;
  /** Most vectors the walk may score; past it the search stops with `aborted`. */
  visitBudget?: number;
  /** One call per expanded node with every neighbour not yet scored, so a store reads them in one query. */
  vectorsOf: BatchLookup;
}

export interface GraphHit {
  node: number;
  score: number;
}

export type SearchResult = { aborted: false; hits: GraphHit[] } | { aborted: true };

type VectorLookup = (node: number) => Float32Array;

/** The vectors of `nodes`, in the same order. */
export type BatchLookup = (nodes: readonly number[]) => readonly Float32Array[];

const MAX_LEVEL = 15;

export function createVectorGraph(opts: VectorGraphOptions): VectorGraph {
  const { dim, m = 16, efConstruction = 200, seed } = opts;
  if (!Number.isInteger(dim) || dim < 1) throw new Error(`vector graph: bad dim ${dim}`);
  if (!Number.isInteger(m) || m < 2) throw new Error(`vector graph: bad m ${m}`);
  return { dim, m, efConstruction, seed, rng: seed >>> 0, entry: -1, maxLevel: -1, nodes: new Map(), unit: new Map() };
}

function nextRandom(graph: VectorGraph): number {
  // mulberry32
  graph.rng = (graph.rng + 0x6d2b79f5) >>> 0;
  let t = graph.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
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
  score: (nodes: readonly number[]) => number[];
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
    const fresh = (ctx.graph.nodes.get(cur.node)?.links[level] ?? []).filter((n) => {
      if (visited.has(n) || !ctx.graph.nodes.has(n)) return false;
      visited.add(n);
      return true;
    });
    if (ctx.budget.left >= 0 && fresh.length > ctx.budget.left) return null;
    if (ctx.budget.left >= 0) ctx.budget.left -= fresh.length;
    const scores = fresh.length > 0 ? ctx.score(fresh) : [];
    for (let i = 0; i < fresh.length; i++) {
      const n = fresh[i];
      const s = scores[i];
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
  let cur: GraphHit[] = [{ node: graph.entry, score: ctx.score([graph.entry])[0] }];
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
  const ctx: WalkContext = {
    graph,
    score: (nodes) => opts.vectorsOf(nodes).map((v) => cosine(query, qNorm, v)),
    admit: opts.admit,
    budget: { left: opts.visitBudget ?? -1 },
  };
  const entry = descend({ ...ctx, admit: undefined }, 0);
  if (!entry) return { aborted: true };
  const found = searchLayer(ctx, entry, Math.max(opts.ef, opts.k), 0);
  if (!found) return { aborted: true };
  found.sort((a, b) => b.score - a.score || a.node - b.node);
  return { aborted: false, hits: found.slice(0, opts.k) };
}

function unitOf(graph: VectorGraph, node: number, vectorOf?: VectorLookup): Float32Array {
  const cached = graph.unit.get(node);
  if (cached) return cached;
  if (!vectorOf) throw new Error(`vector graph: no vector for node ${node}`);
  // A merge reaches the same restored nodes thousands of times; recomputing each unit was most of its time.
  const unit = toUnit(vectorOf(node));
  graph.unit.set(node, unit);
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

/** Add one node. `vectorOf` is needed only when earlier nodes came from `restoreGraph` and have no cached vector. */
export function insertNode(graph: VectorGraph, node: number, vector: Float32Array, vectorOf?: VectorLookup): void {
  if (vector.length !== graph.dim) throw new Error(`vector graph: expected dim ${graph.dim}, got ${vector.length}`);
  if (graph.nodes.has(node)) throw new Error(`vector graph: node ${node} already inserted`);
  const q = toUnit(vector);
  const level = Math.min(MAX_LEVEL, Math.floor(-Math.log(1 - nextRandom(graph)) / Math.log(graph.m)));
  graph.unit.set(node, q);
  const data: GraphNodeData = { level, links: Array.from({ length: level + 1 }, () => []) };
  if (graph.entry < 0) {
    graph.nodes.set(node, data);
    graph.entry = node;
    graph.maxLevel = level;
    return;
  }
  const unitFor = (n: number) => unitOf(graph, n, vectorOf);
  const ctx: WalkContext = { graph, score: (nodes) => nodes.map((n) => dot(q, unitFor(n))), budget: { left: -1 } };
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

export function graphMeta(graph: VectorGraph): GraphMeta {
  const { dim, m, efConstruction, seed, rng, entry, maxLevel } = graph;
  return { dim, m, efConstruction, seed, rng, entry, maxLevel };
}

/** Every node in insert order with its per-level neighbour lists, ready to pack into rows. */
export function* graphNodes(graph: VectorGraph): Generator<GraphNode> {
  for (const [node, data] of graph.nodes) {
    yield { node, level: data.level, neighbours: data.links.map((l) => Uint32Array.from(l)) };
  }
}

export function restoreGraph(meta: GraphMeta, nodes: Iterable<GraphNode>): VectorGraph {
  const graph = createVectorGraph(meta);
  graph.rng = meta.rng;
  graph.entry = meta.entry;
  graph.maxLevel = meta.maxLevel;
  for (const { node, level, neighbours } of nodes) {
    graph.nodes.set(node, { level, links: neighbours.map((l) => Array.from(l)) });
  }
  return graph;
}
