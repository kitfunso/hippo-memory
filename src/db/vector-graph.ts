// Handwritten HNSW graph (Malkov and Yashunin) over plain data: no database, no I/O. Same seed and
// insert order give the same graph.

import { stepMulberry32 } from '../base/util/prng.js';
import { ZERO_NORM, cosineToQuery, dot, norm } from '../base/rank/cosine.js';

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

/** A graph a search can walk, held in memory or read from a file as the walk reaches each node. */
export interface GraphView {
  readonly dim: number;
  /** The node every search starts from; -1 for an empty graph. */
  readonly entry: number;
  readonly maxLevel: number;
  /** The links of `node` at `level`; a view over a file throws on a link it cannot trust. */
  linksOf(node: number, level: number): ArrayLike<number>;
}

export interface VectorGraphSearchOptions {
  k: number;
  ef: number;
  /** Checked for every candidate before it can enter the result; a rejected node is still
   * walked through. */
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

/** `visited` counts the nodes the bottom layer's walk reached, so a caller can tell a walk that
 * reached every node. */
export type SearchResult =
  | { aborted: false; hits: GraphHit[]; visited: number }
  | { aborted: true };

type VectorLookup = (node: number) => Float32Array;

// A larger M or efConstruction cost far more build than it bought recall; docs/ARCHITECTURE.md has
// the bench.
export const GRAPH_M = 16;
export const GRAPH_EF_CONSTRUCTION = 100;
const MAX_LEVEL = 15;
// Float32 rounding leaves a normalised vector's squared length within about 1e-6 of one.
const UNIT_TOLERANCE = 1e-5;

export function createVectorGraph(opts: VectorGraphOptions): VectorGraph {
  const { dim, m = GRAPH_M, efConstruction = GRAPH_EF_CONSTRUCTION, seed } = opts;
  if (!Number.isInteger(dim) || dim < 1) throw new Error(`vector graph: bad dim ${dim}`);
  if (!Number.isInteger(m) || m < 2) throw new Error(`vector graph: bad m ${m}`);
  return {
    dim,
    m,
    efConstruction,
    seed,
    rng: seed >>> 0,
    entry: -1,
    maxLevel: -1,
    nodes: new Map(),
    unit: new Map(),
  };
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

function toUnit(v: Float32Array): Float32Array {
  const n = norm(v);
  if (n < ZERO_NORM) return new Float32Array(v.length);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

interface WalkContext {
  graph: GraphView;
  score: (node: number) => number;
  admit?: (node: number) => boolean;
  /** Vectors still allowed to be scored, shared by every layer of one search; negative means
   * no budget. */
  budget: { left: number };
  /** Nodes the last layer's walk reached. */
  visited: number;
}

/** Best-first walk of one layer: the ef best admitted candidates, best first, or null when the
 * budget ran out. */
function searchLayer(
  ctx: WalkContext,
  entries: GraphHit[],
  ef: number,
  level: number,
): GraphHit[] | null {
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
    const links = ctx.graph.linksOf(cur.node, level);
    for (let i = 0; i < links.length; i++) {
      const n = links[i];
      if (visited.has(n)) continue;
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
  ctx.visited = visited.size;
  const out: GraphHit[] = [];
  while (result.size > 0) out.push(result.pop());
  return out.reverse();
}

/** Walk down from the entry through the upper layers (ef 1, no filter) and return the entries
 * for layer `stop`. */
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

const NO_LINKS: readonly number[] = [];

/** The in-memory graph as a search walks it. */
function viewOf(graph: VectorGraph): GraphView {
  const { dim, entry, maxLevel, nodes } = graph;
  return {
    dim,
    entry,
    maxLevel,
    linksOf: (node, level) => nodes.get(node)?.links[level] ?? NO_LINKS,
  };
}

export function searchGraph(
  graph: VectorGraph,
  query: Float32Array,
  opts: VectorGraphSearchOptions,
): SearchResult {
  return searchView(viewOf(graph), query, {
    ...opts,
    vectorOf: opts.vectorOf ?? ((n: number) => unitOf(graph, n)),
  });
}

/** searchGraph over any view; `vectorOf` scores each node it reaches. */
export function searchView(
  graph: GraphView,
  query: Float32Array,
  opts: VectorGraphSearchOptions & { vectorOf: VectorLookup },
): SearchResult {
  if (graph.entry < 0 || opts.k <= 0 || query.length !== graph.dim) {
    return { aborted: false, hits: [], visited: 0 };
  }
  const qNorm = norm(query);
  const vectorOf = opts.vectorOf;
  // A directionless query or row scores 0, where the full scan in vector-match.ts drops it.
  const score = (n: number): number =>
    qNorm < ZERO_NORM ? 0 : (cosineToQuery(query, qNorm, vectorOf(n)) ?? 0);
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
    score,
    admit: memo,
    budget: { left: opts.visitBudget ?? -1 },
    visited: 0,
  };
  const entry = descend({ ...ctx, admit: undefined }, 0);
  if (!entry) return { aborted: true };
  const found = searchLayer(ctx, entry, Math.max(opts.ef, opts.k), 0);
  if (!found) return { aborted: true };
  found.sort((a, b) => b.score - a.score || a.node - b.node);
  return { aborted: false, hits: found.slice(0, opts.k), visited: ctx.visited };
}

function unitOf(graph: VectorGraph, node: number): Float32Array {
  const unit = graph.unit.get(node);
  if (!unit) throw new Error(`vector graph: no vector for node ${node}`);
  return unit;
}

/** Algorithm 4 without extendCandidates or keepPrunedConnections; `cands` must be sorted
 * best first. */
function selectNeighbours(cands: GraphHit[], m: number, unitFor: VectorLookup): number[] {
  const kept: number[] = [];
  for (const c of cands) {
    if (kept.length >= m) break;
    const cu = unitFor(c.node);
    if (kept.every((r) => dot(cu, unitFor(r)) <= c.score)) kept.push(c.node);
  }
  return kept;
}

/** A link from node `from` to node `to` at `level`. */
interface BackLinkOptions {
  readonly from: number;
  readonly to: number;
  readonly level: number;
}

function addBackLink(
  graph: VectorGraph,
  { from, to, level }: BackLinkOptions,
  unitFor: VectorLookup,
): void {
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

/** Add one node. A vector already of unit length is kept as given, not copied, so the caller
 * must not change it. */
export function insertNode(graph: VectorGraph, node: number, vector: Float32Array): void {
  if (vector.length !== graph.dim) {
    throw new Error(`vector graph: expected dim ${graph.dim}, got ${vector.length}`);
  }
  if (graph.nodes.has(node)) throw new Error(`vector graph: node ${node} already inserted`);
  const q = Math.abs(dot(vector, vector) - 1) < UNIT_TOLERANCE ? vector : toUnit(vector);
  const level = Math.min(
    MAX_LEVEL,
    Math.floor(-Math.log(1 - nextRandom(graph)) / Math.log(graph.m)),
  );
  graph.unit.set(node, q);
  const data: GraphNodeData = { level, links: Array.from({ length: level + 1 }, () => []) };
  if (graph.entry < 0) {
    graph.nodes.set(node, data);
    graph.entry = node;
    graph.maxLevel = level;
    return;
  }
  const unitFor = (n: number) => unitOf(graph, n);
  const ctx: WalkContext = {
    graph: viewOf(graph),
    score: (n) => dot(q, unitFor(n)),
    budget: { left: -1 },
    visited: 0,
  };
  let entries = descend(ctx, level) ?? unreachable();
  for (let l = Math.min(level, graph.maxLevel); l >= 0; l--) {
    const found = searchLayer(ctx, entries, graph.efConstruction, l) ?? unreachable();
    data.links[l] = selectNeighbours(found, graph.m, unitFor);
    entries = found;
  }
  graph.nodes.set(node, data);
  for (let l = 0; l <= Math.min(level, graph.maxLevel); l++) {
    for (const n of data.links[l]) addBackLink(graph, { from: n, to: node, level: l }, unitFor);
  }
  if (level > graph.maxLevel) {
    graph.maxLevel = level;
    graph.entry = node;
  }
}
