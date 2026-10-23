// One store's memory_vectors as an HNSW graph: which row each node came from, the reads that bring the graph up to
// date, and the search whose candidates SQL admits and the stored vectors score.
import type { DatabaseSyncLike } from './sqlite.js';
import { getMeta } from './meta.js';
import { createVectorGraph, insertNode, searchGraph, type SearchResult, type VectorGraph } from './vector-graph.js';
import {
  admittedVectorsSql,
  decodeVector,
  EMBEDDING_MODEL_META_KEY,
  rankVectorRows,
  type VectorMatch,
  type VectorMatchQuery,
  type VectorRow,
} from './vector-store.js';
import { cachedStatement } from './statement-cache.js';
import { placeholders } from './sql.js';

// The graph beat the paged scan at both p50 and p95 from 1,000 vectors on; docs/ARCHITECTURE.md has the bench.
/** Stored vectors a store holds before its nearest-row reads search a graph. */
export const VECTOR_GRAPH_THRESHOLD = 1_000;
/** Share of a graph's nodes that may be stale, or its file's rows new, before it is rebuilt. */
export const STALE_SHARE = 0.1;

// A larger M or efConstruction cost far more build than it bought recall; docs/ARCHITECTURE.md has the bench.
const GRAPH_M = 16;
const GRAPH_EF_CONSTRUCTION = 100;
const GRAPH_SEED = 1;

// The first walk asks for this many candidates per wanted row, at least EF_FLOOR, and doubles up to EF_CAP. A lower
// floor lost recall where the nearest rows barely stand out, for little time saved.
const EF_PER_ROW = 4;
const EF_FLOOR = 128;
const EF_CAP = 2048;

// Rows below the newest one read that may be checked for the newest row still holding what the graph read.
const INTACT_WALK = 32;

const BLOCK_ROWS = 1024;

export interface GraphRows {
  readonly graph: VectorGraph;
  /** The index identity the vectors were read under; another one means every node is from an older model. */
  readonly model: string;
  /** The memory id and rowid of each node. */
  readonly ids: string[];
  readonly rowids: number[];
  /** The node that holds each memory's current vector; a node no id points at holds a replaced one. */
  readonly nodeOf: Map<string, number>;
  /** The highest rowid read. */
  lastRowid: number;
  /** Stored vectors at the last count, plus the memories added since. */
  live: number;
}

export function emptyGraphRows(dim: number, model: string): GraphRows {
  const graph = createVectorGraph({ dim, m: GRAPH_M, efConstruction: GRAPH_EF_CONSTRUCTION, seed: GRAPH_SEED });
  return { graph, model, ids: [], rowids: [], nodeOf: new Map(), lastRowid: 0, live: 0 };
}

/** Nodes left behind by a replaced or deleted vector, as far as the last count shows. */
export function staleNodes(g: GraphRows): number {
  return g.ids.length - g.live;
}

/** Adds the row unless the graph already holds it at that rowid; a memory seen again replaces its old node. */
export function addRow(g: GraphRows, rowid: number, id: string, vector: Float32Array): void {
  const was = g.nodeOf.get(id);
  if (was !== undefined && g.rowids[was] === rowid) return;
  const node = g.ids.length;
  insertNode(g.graph, node, vector);
  g.ids.push(id);
  g.rowids.push(rowid);
  g.nodeOf.set(id, node);
  if (was === undefined) g.live++;
  g.lastRowid = Math.max(g.lastRowid, rowid);
}

// SAFETY: every read cast to this row selects ROWS_ABOVE_SQL; scripts/check-row-casts.mjs proves it.
// node:sqlite returns BLOBs as Uint8Array.
export interface StoredRow {
  readonly rowid: number;
  readonly id: string;
  readonly vector: Uint8Array;
}

/** Rows of length `dim` above `afterRowid`, oldest first; the build iterates it on one cursor. */
export const ROWS_ABOVE_SQL = `SELECT rowid AS rowid, memory_id AS id, vector FROM memory_vectors
  WHERE rowid > ? AND dim = ? ORDER BY rowid`;

export function storedModel(db: DatabaseSyncLike): string {
  return getMeta(db, EMBEDDING_MODEL_META_KEY, '');
}

/** Vectors read for a build, normalised in place in blocks, so the graph keeps them as its own unit vectors. */
export class StagedRows {
  readonly ids: string[] = [];
  readonly rowids: number[] = [];
  readonly #blocks: Float32Array[] = [];
  readonly #dim: number;

  constructor(dim: number) {
    this.#dim = dim;
  }

  get length(): number {
    return this.ids.length;
  }

  // A blob of another length is skipped, as the scan skips it.
  add(row: StoredRow): void {
    if (row.vector.byteLength !== this.#dim * 4) return;
    const at = this.ids.length;
    if (at % BLOCK_ROWS === 0) this.#blocks.push(new Float32Array(BLOCK_ROWS * this.#dim));
    const v = this.vector(at);
    new Uint8Array(v.buffer, v.byteOffset, v.byteLength).set(row.vector);
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm >= 1e-10) for (let i = 0; i < v.length; i++) v[i] /= norm;
    this.ids.push(row.id);
    this.rowids.push(row.rowid);
  }

  vector(i: number): Float32Array {
    const block = this.#blocks[Math.floor(i / BLOCK_ROWS)];
    const start = (i % BLOCK_ROWS) * this.#dim;
    return block.subarray(start, start + this.#dim);
  }
}

/** The highest rowid at or below the last one read whose row still holds the memory read there, or undefined when none
 * of the newest rows does. SQLite hands a deleted top rowid out again, so rows above it may be new. */
function intactRowid(db: DatabaseSyncLike, g: GraphRows): number | undefined {
  const rows = db
    .prepare('SELECT rowid AS rowid, memory_id AS id FROM memory_vectors WHERE rowid <= ? ORDER BY rowid DESC LIMIT ?')
    .iterate(g.lastRowid, INTACT_WALK) as Iterable<{ rowid: number; id: string }>;
  let seen = 0;
  for (const row of rows) {
    seen++;
    const node = g.nodeOf.get(row.id);
    if (node !== undefined && g.rowids[node] === row.rowid) return row.rowid;
  }
  return seen < INTACT_WALK ? 0 : undefined;
}

/** 'lost' when the graph no longer matches the store; 'behind' with where a background read starts when more rows are
 * new than one query should insert. */
export type CatchUp = { readonly kind: 'current' | 'lost' } | { readonly kind: 'behind'; readonly afterRowid: number };

/** Inserts the rows another connection wrote since the graph last read, up to `inlineRows` of them. */
export function catchUp(db: DatabaseSyncLike, g: GraphRows, inlineRows: number): CatchUp {
  if (storedModel(db) !== g.model) return { kind: 'lost' };
  const afterRowid = intactRowid(db, g);
  if (afterRowid === undefined) return { kind: 'lost' };
  const rows = cachedStatement(db, `${ROWS_ABOVE_SQL} LIMIT ?`).all(
    afterRowid,
    g.graph.dim,
    inlineRows + 1,
  ) as StoredRow[];
  if (rows.length > inlineRows) return { kind: 'behind', afterRowid };
  g.lastRowid = afterRowid;
  for (const row of rows) {
    if (row.vector.byteLength === g.graph.dim * 4) addRow(g, row.rowid, row.id, decodeVector(row.vector));
  }
  return { kind: 'current' };
}

/** The rows among `keys` (memory ids or rowids) that pass `where`, with their stored vectors. */
export function admittedRows(
  db: DatabaseSyncLike,
  key: 'memory_id' | 'rowid',
  keys: readonly (string | number)[],
  { dim, where, params }: { dim: number; where: string; params: readonly (string | number)[] },
): VectorRow[] {
  if (keys.length === 0) return [];
  const among = `v.${key} IN (${placeholders(keys.length)}) AND `;
  // SAFETY: node:sqlite returns BLOBs as Uint8Array.
  const rows = cachedStatement(db, admittedVectorsSql(where, among)).all(...keys, dim, ...params) as Array<{
    id: string;
    vector: Uint8Array;
  }>;
  return rows.map((row) => ({ id: row.id, vector: decodeVector(row.vector) }));
}

/** A graph's search for a query: `walk` asks for the `ef` best nodes it may admit, `admit` reads the rows of new ones
 * that pass the filter, and `nodes` is how many the graph holds. */
export interface ProposalSearch {
  readonly nodes: number;
  readonly walk: (ef: number) => SearchResult;
  readonly admit: (nodes: readonly number[]) => VectorRow[];
}

/** The `k` admitted rows nearest `query`, or undefined when the graph cannot find `k`, so the caller scans. Each walk
 * asks twice the candidates of the last; one that reached every node has seen every row, so it answers with fewer. */
export function proposedMatches(
  query: readonly number[],
  k: number,
  search: ProposalSearch,
): VectorMatch[] | undefined {
  const asked = new Set<number>();
  const admitted: VectorRow[] = [];
  for (let ef = Math.max(k * EF_PER_ROW, EF_FLOOR); ; ef *= 2) {
    const found = search.walk(ef);
    if (found.aborted) return undefined;
    const fresh = found.hits.map((hit) => hit.node).filter((node) => !asked.has(node));
    for (const node of fresh) asked.add(node);
    admitted.push(...search.admit(fresh));
    const all = found.hits.length < ef && found.visited >= search.nodes;
    if (admitted.length >= k || all) return rankVectorRows(query, admitted, k);
    if (found.hits.length < ef || ef >= EF_CAP) return undefined;
  }
}

/** graphMatches on the graph a store worker holds, whose nodes SQL admits by memory id. */
export function graphMatches(
  db: DatabaseSyncLike,
  g: GraphRows,
  { query, k, where, params }: VectorMatchQuery,
): VectorMatch[] | undefined {
  const q = Float32Array.from(query);
  const current = (node: number): boolean => g.nodeOf.get(g.ids[node]) === node;
  const filter = { dim: q.length, where, params };
  return proposedMatches(query, k, {
    nodes: g.ids.length,
    walk: (ef) => searchGraph(g.graph, q, { k: ef, ef, admit: current }),
    admit: (nodes) =>
      admittedRows(
        db,
        'memory_id',
        nodes.map((node) => g.ids[node]),
        filter,
      ),
  });
}
