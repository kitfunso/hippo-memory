// The vector graph's rows in hippo.db: one neighbour BLOB per node, the meta rows, and the build and merge that write
// them. A build or merge computes in memory, then lands in one write scope only if no other writer moved `generation`.
import type { DatabaseSyncLike } from './sqlite.js';
import { withReadSnapshot, withWriteScope } from './busy.js';
import { cosineOf } from '../core/cosine.js';
import { log } from '../util/log.js';
import {
  createVectorGraph,
  graphMeta,
  graphNodes,
  insertNode,
  restoreGraph,
  searchGraph,
  type GraphHit,
  type GraphMeta,
  type GraphNode,
  type VectorGraph,
} from '../util/vector-graph.js';

/** Fewest graph nodes before nearest-vector search walks the graph; below it the exact scan is fast enough. */
export const VECTOR_GRAPH_MIN_ROWS = 20_000;

// Slice 1's bench: M 16 with efConstruction 200 missed the .97 recall gate at a 30% filter; 24 with 300 passed.
const GRAPH_M = 24;
const GRAPH_EF_CONSTRUCTION = 300;
const GRAPH_SEED = 59;
const MERGE_ATTEMPTS = 3;
const RECALL_QUERIES = 20;
const RECALL_K = 10;
const RECALL_EF = 128;
const RECALL_FLOOR = 0.95;

/** A loaded graph, the memory id behind each node, and the generation it was read at. */
export interface StoredGraph {
  readonly graph: VectorGraph;
  readonly ids: ReadonlyMap<number, string>;
  readonly generation: number;
}

// The merge's own copy, which it grows; the search cache only ever sees it as a StoredGraph.
interface OwnedGraph extends StoredGraph {
  readonly ids: Map<number, string>;
}

interface NodeRow {
  node: number;
  memory_id: string;
  level: number;
  nbrs: Uint8Array;
}

function copyVector(blob: Uint8Array): Float32Array {
  return new Float32Array(new Uint8Array(blob).buffer);
}

/** [level count][length of each level][ids, level 0 first], every word a little-endian Uint32. */
function packNeighbours(lists: readonly Uint32Array[]): Uint8Array {
  const view = new DataView(new ArrayBuffer(4 * (1 + lists.length + lists.reduce((n, l) => n + l.length, 0))));
  let at = 0;
  const put = (value: number): void => {
    view.setUint32(at, value, true);
    at += 4;
  };
  put(lists.length);
  for (const l of lists) put(l.length);
  for (const l of lists) for (const n of l) put(n);
  return new Uint8Array(view.buffer);
}

function unpackNeighbours(row: NodeRow): Uint32Array[] {
  const { nbrs: blob } = row;
  const words = blob.byteLength % 4 === 0 ? blob.byteLength / 4 : 0;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const read = (i: number): number => view.getUint32(4 * i, true);
  const levels = words > 0 ? read(0) : 0;
  const fits = levels === row.level + 1 && levels < words;
  const lengths = fits ? Array.from({ length: levels }, (_, l) => read(1 + l)) : [];
  if (lengths.length === 0 || 1 + levels + lengths.reduce((a, b) => a + b, 0) !== words) {
    throw new Error(`vector graph: node ${row.node} has a malformed neighbour list`);
  }
  let at = 1 + levels;
  return lengths.map((len) => {
    const out = new Uint32Array(len);
    for (let i = 0; i < len; i++) out[i] = read(at + i);
    at += len;
    return out;
  });
}

// node:sqlite binds a JS number as REAL, so the numeric rows are integer or real; only `model` is text.
const NUMERIC = `typeof(value) IN ('integer', 'real')`;

function readMeta(db: DatabaseSyncLike): Map<string, number> {
  // SAFETY: the SELECT names exactly these two columns and keeps only numeric values.
  const rows = db.prepare(`SELECT key, value FROM memory_vector_index_meta WHERE ${NUMERIC}`).all() as
    { key: string; value: number }[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

function metaNumber(meta: ReadonlyMap<string, number>, key: string): number {
  const value = meta.get(key);
  if (value === undefined) throw new Error(`vector graph: meta row ${key} is missing`);
  return value;
}

function metaModel(db: DatabaseSyncLike): string {
  // SAFETY: the SELECT names exactly the one column read and keeps it only when it is text.
  const row = db.prepare(`SELECT value FROM memory_vector_index_meta WHERE key = 'model' AND typeof(value) = 'text'`)
    .get() as { value: string } | undefined;
  return row?.value ?? '';
}

/** The meta `generation`, bumped by every graph write; null on a store that never had a graph. */
export function graphGeneration(db: DatabaseSyncLike): number | null {
  // SAFETY: the SELECT names exactly the one column read and keeps it only when it is a number.
  const row = db.prepare(`SELECT value FROM memory_vector_index_meta WHERE key = 'generation' AND ${NUMERIC}`).get() as
    { value: number } | undefined;
  return row?.value ?? null;
}

function bumpGeneration(db: DatabaseSyncLike): void {
  db.prepare(
    `INSERT INTO memory_vector_index_meta (key, value) VALUES ('generation', 1)
     ON CONFLICT(key) DO UPDATE SET value = value + 1`,
  ).run();
}

// The entry node may be gone (a raw DELETE); every load then picks the same stand-in from what is left.
function entryOf(nodes: readonly GraphNode[], entry: number): Pick<GraphMeta, 'entry' | 'maxLevel'> {
  const kept = nodes.find((n) => n.node === entry);
  if (kept) return { entry, maxLevel: kept.level };
  let best = nodes[0];
  for (const n of nodes) if (n.level > best.level) best = n;
  return { entry: best.node, maxLevel: best.level };
}

function readNodes(db: DatabaseSyncLike, ids: Map<number, string>): GraphNode[] {
  const nodes: GraphNode[] = [];
  // SAFETY: the SELECT names exactly these four columns; node:sqlite returns BLOBs as Uint8Array.
  const rows = db.prepare('SELECT node, memory_id, level, nbrs FROM memory_vector_nodes ORDER BY node').iterate() as
    Iterable<NodeRow>;
  for (const row of rows) {
    nodes.push({ node: row.node, level: row.level, neighbours: unpackNeighbours(row) });
    ids.set(row.node, row.memory_id);
  }
  return nodes;
}

/** The stored graph, or null when there is none (no meta, or every node deleted); a malformed row throws. */
export function loadGraph(db: DatabaseSyncLike): OwnedGraph | null {
  return withReadSnapshot(db, () => {
    const meta = readMeta(db);
    if (!meta.has('dim') || !meta.has('generation')) return null;
    const ids = new Map<number, string>();
    const read = readNodes(db, ids);
    if (read.length === 0) return null;
    // Links to deleted nodes go, so neither a walk nor a merge's back-link pruning reads a vector that is gone.
    const nodes = read.map((n) => ({ ...n, neighbours: n.neighbours.map((l) => l.filter((x) => ids.has(x))) }));
    const graph = restoreGraph({
      dim: metaNumber(meta, 'dim'),
      m: metaNumber(meta, 'm'),
      efConstruction: metaNumber(meta, 'efConstruction'),
      seed: metaNumber(meta, 'seed'),
      rng: metaNumber(meta, 'rng'),
      ...entryOf(nodes, metaNumber(meta, 'entry')),
    }, nodes);
    return { graph, ids, generation: metaNumber(meta, 'generation') };
  });
}

/** Reads a node's stored vector by its memory id; a gone or resized row reads as zeros, which scores 0. */
function vectorReader(
  db: DatabaseSyncLike,
  ids: ReadonlyMap<number, string>,
  dim: number,
): (node: number) => Float32Array {
  const read = db.prepare('SELECT vector FROM memory_vectors WHERE memory_id = ?');
  const zero = new Float32Array(dim);
  return (node) => {
    const id = ids.get(node);
    // SAFETY: the SELECT names exactly the one column read; node:sqlite returns BLOBs as Uint8Array.
    const row = id === undefined ? undefined : read.get(id) as { vector: Uint8Array } | undefined;
    return row !== undefined && row.vector.byteLength === dim * 4 ? copyVector(row.vector) : zero;
  };
}

function writeGraph(db: DatabaseSyncLike, graph: VectorGraph, ids: ReadonlyMap<number, string>, model: string): void {
  db.exec('DELETE FROM memory_vector_nodes');
  // A vector deleted while the graph was computed gets no node back: its delete trigger has already run.
  const put = db.prepare(
    `INSERT INTO memory_vector_nodes (node, memory_id, level, nbrs)
     SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memory_vectors WHERE memory_id = ?)`,
  );
  let written = 0;
  for (const n of graphNodes(graph)) {
    const id = ids.get(n.node);
    if (id !== undefined) written += Number(put.run(n.node, id, n.level, packNeighbours(n.neighbours), id).changes);
  }
  const meta = db.prepare('INSERT OR REPLACE INTO memory_vector_index_meta (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries({ ...graphMeta(graph), model, nodes: written })) meta.run(key, value);
  bumpGeneration(db);
}

function dropPending(db: DatabaseSyncLike, ids: Iterable<string>): void {
  const del = db.prepare('DELETE FROM memory_vector_pending WHERE memory_id = ?');
  for (const id of ids) del.run(id);
}

// Commits only when no other writer moved the generation since `seen`, so two merges never drop each other's rows.
function commitAt(db: DatabaseSyncLike, seen: number | null, write: () => void): boolean {
  return withWriteScope(db, 'vector_graph_write', () => {
    if (graphGeneration(db) !== seen) return false;
    write();
    return true;
  });
}

/** Empties the graph, its queue and its meta, keeping a bumped `generation` so no process reuses a cached graph. */
export function clearGraph(db: DatabaseSyncLike): void {
  db.exec(`
    DELETE FROM memory_vector_nodes;
    DELETE FROM memory_vector_pending;
    DELETE FROM memory_vector_index_meta WHERE key != 'generation';
  `);
  bumpGeneration(db);
}

interface DimGroup {
  readonly dim: number;
  readonly model: string;
}

function largestDimGroup(db: DatabaseSyncLike): DimGroup | null {
  // SAFETY: the SELECT names exactly these two columns.
  const row = db.prepare(
    'SELECT dim, MAX(model) AS model FROM memory_vectors GROUP BY dim ORDER BY COUNT(*) DESC, dim LIMIT 1',
  ).get() as DimGroup | undefined;
  return row ?? null;
}

/** Builds a new graph over every stored vector of the most common dim; returns its size, 0 when another writer moved
 * the graph first or there is no vector. */
export function buildGraph(db: DatabaseSyncLike): number {
  const seen = graphGeneration(db);
  const group = largestDimGroup(db);
  if (!group) return 0;
  const graph = createVectorGraph({
    dim: group.dim,
    m: GRAPH_M,
    efConstruction: GRAPH_EF_CONSTRUCTION,
    seed: GRAPH_SEED,
  });
  const ids = new Map<number, string>();
  // SAFETY: the SELECT names exactly these two columns; node:sqlite returns BLOBs as Uint8Array.
  const rows = db.prepare('SELECT memory_id, vector FROM memory_vectors WHERE dim = ? ORDER BY memory_id')
    .iterate(group.dim) as Iterable<{ memory_id: string; vector: Uint8Array }>;
  for (const row of rows) {
    const node = ids.size;
    insertNode(graph, node, copyVector(row.vector));
    ids.set(node, row.memory_id);
  }
  const done = commitAt(db, seen, () => {
    writeGraph(db, graph, ids, group.model);
    dropPending(db, ids.values());
  });
  return done ? ids.size : 0;
}

interface MergePlan {
  readonly consumed: string[];
  readonly merged: number;
  readonly model: string;
}

function planMerge(
  db: DatabaseSyncLike,
  stored: OwnedGraph,
  cap: number,
  vectorOf: (node: number) => Float32Array,
): MergePlan {
  const { graph, ids } = stored;
  const hasNode = new Set(ids.values());
  let next = 0;
  for (const node of ids.keys()) next = Math.max(next, node + 1);
  // SAFETY: the SELECT names exactly these three columns; a queued row whose vector is gone reads NULL.
  const rows = db.prepare(
    `SELECT p.memory_id AS id, v.vector AS vector, v.model AS model FROM memory_vector_pending p
     LEFT JOIN memory_vectors v ON v.memory_id = p.memory_id ORDER BY p.memory_id LIMIT ?`,
  ).all(cap) as { id: string; vector: Uint8Array | null; model: string | null }[];
  let merged = 0;
  let model = '';
  for (const row of rows) {
    // Already a node (a re-embed): the stale node costs recall only, and the re-score reads the current vector.
    if (hasNode.has(row.id) || row.vector === null || row.vector.byteLength !== graph.dim * 4) continue;
    insertNode(graph, next, copyVector(row.vector), vectorOf);
    ids.set(next++, row.id);
    model = row.model ?? model;
    merged++;
  }
  return { consumed: rows.map((r) => r.id), merged, model };
}

interface MergeOutcome {
  readonly merged: number;
  readonly recall: number;
}

/** Inserts up to `cap` queued vectors into the stored graph and drops them from the queue; a queued row that already
 * has a node, or another dim, just leaves it. Null when there is no graph to merge into. */
export function mergePending(db: DatabaseSyncLike, cap: number): MergeOutcome | null {
  for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
    const stored = loadGraph(db);
    if (!stored) return null;
    const vectorOf = vectorReader(db, stored.ids, stored.graph.dim);
    const plan = planMerge(db, stored, cap, vectorOf);
    if (plan.consumed.length === 0) return { merged: 0, recall: 1 };
    const model = plan.model || metaModel(db);
    if (commitAt(db, stored.generation, () => {
      writeGraph(db, stored.graph, stored.ids, model);
      dropPending(db, plan.consumed);
    })) {
      return { merged: plan.merged, recall: plan.merged > 0 ? sampledRecall(db, stored.graph, vectorOf) : 1 };
    }
  }
  // Another writer won every round; the queue is untouched, so the next sleep merges it.
  return { merged: 0, recall: 1 };
}

function offerTop(top: GraphHit[], hit: GraphHit): void {
  const worse = (a: GraphHit, b: GraphHit): boolean => a.score < b.score || (a.score === b.score && a.node > b.node);
  if (top.length === RECALL_K && !worse(top[RECALL_K - 1], hit)) return;
  let i = top.length;
  while (i > 0 && worse(top[i - 1], hit)) i--;
  top.splice(i, 0, hit);
  if (top.length > RECALL_K) top.pop();
}

/** The graph's unfiltered top 10 against an exact scan of the written nodes, 20 stored vectors at a fixed stride as
 * the queries. */
function sampledRecall(db: DatabaseSyncLike, graph: VectorGraph, vectorOf: (node: number) => Float32Array): number {
  const nodes = [...graph.nodes.keys()].sort((a, b) => a - b);
  const stride = Math.max(1, Math.floor(nodes.length / RECALL_QUERIES));
  const queries = nodes.filter((_, i) => i % stride === 0).slice(0, RECALL_QUERIES).map(vectorOf);
  const exact = queries.map((): GraphHit[] => []);
  // SAFETY: the SELECT names exactly these two columns; node:sqlite returns BLOBs as Uint8Array.
  const rows = db.prepare(
    `SELECT n.node AS node, v.vector AS vector FROM memory_vector_nodes n
     JOIN memory_vectors v ON v.memory_id = n.memory_id WHERE v.dim = ?`,
  ).iterate(graph.dim) as Iterable<{ node: number; vector: Uint8Array }>;
  for (const row of rows) {
    const v = copyVector(row.vector);
    queries.forEach((q, i) => offerTop(exact[i], { node: row.node, score: cosineOf(q, v) }));
  }
  let hit = 0;
  // The merge left most nodes' unit vectors in graph.unit; cosine reads them as it would the stored ones.
  const vectorsOf = (nodes: readonly number[]): Float32Array[] => nodes.map((n) => graph.unit.get(n) ?? vectorOf(n));
  queries.forEach((q, i) => {
    const want = new Set(exact[i].map((h) => h.node));
    const found = searchGraph(graph, q, { k: RECALL_K, ef: RECALL_EF, vectorsOf });
    if (!found.aborted) hit += found.hits.filter((h) => want.has(h.node)).length;
  });
  const total = exact.reduce((n, e) => n + e.length, 0);
  return total === 0 ? 1 : hit / total;
}

function storedVectorCount(db: DatabaseSyncLike): number {
  // SAFETY: the SELECT names exactly the one column read.
  return (db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get() as { n: number }).n;
}

/** Builds the graph when the store has `minRows` vectors or more; returns the node count, 0 when it built none. */
export function buildGraphIfLarge(db: DatabaseSyncLike, minRows = VECTOR_GRAPH_MIN_ROWS): number {
  return storedVectorCount(db) >= minRows ? buildGraph(db) : 0;
}

interface GraphRefresh {
  readonly built: number;
  readonly merged: number;
}

/** Sleep's upkeep: build when there is no graph and the store is large, else merge up to `cap` queued vectors, and
 * rebuild when the merged graph's sampled recall falls under .95. */
export function refreshGraph(db: DatabaseSyncLike, cap: number): GraphRefresh {
  const merge = mergePending(db, cap);
  if (merge === null) return { built: buildGraphIfLarge(db), merged: 0 };
  if (merge.merged > 0) log.info(`vector graph: merged ${merge.merged}, sampled recall ${merge.recall.toFixed(3)}`);
  if (merge.recall >= RECALL_FLOOR) return { built: 0, merged: merge.merged };
  log.warn(`vector graph: sampled recall ${merge.recall.toFixed(3)} is under ${RECALL_FLOOR}; rebuilding`);
  return { built: buildGraph(db), merged: merge.merged };
}
