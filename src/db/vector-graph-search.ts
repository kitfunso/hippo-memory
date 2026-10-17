// The path choice for one nearest-vector query: the graph walk with the caller's filter inside it, or null for the
// exact scan. A filter that admits too few rows, a small graph or an aborted walk all fall back to the scan.
import type { DatabaseSyncLike } from './sqlite.js';
import { envVectorIndexExact } from '../util/env.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { placeholders } from '../util/sql.js';
import { searchGraph } from '../util/vector-graph.js';
import { graphGeneration, loadGraph, VECTOR_GRAPH_MIN_ROWS, type StoredGraph } from './vector-graph-rows.js';

/** Knobs for tests and the bench; recall passes none. */
export interface VectorSearchOptions {
  /** Fewest graph nodes, and admitted nodes, before the graph answers; default 20,000. */
  readonly minGraphRows?: number;
  /** Replaces the search width, 128. */
  readonly ef?: number;
  /** Replaces the smallest share of nodes the filter must admit before the graph answers, 0.5. */
  readonly minSelectivity?: number;
}

// Bench at 30k rows (docs/ARCHITECTURE.md): the graph beat the exact scan with 50% of nodes admitted, lost at 30%.
const MIN_SELECTIVITY = 0.5;
// Fixed, not grown by 1/selectivity: the walk already runs until ef admitted hits, so the two compounded.
const EF = 128;
const VISIT_BUDGET = 20_000;
const ID_CHUNK = 500;

interface CachedGraph {
  readonly generation: number;
  readonly stored: StoredGraph | null;
  readonly nodeOf: ReadonlyMap<string, number>;
}

// One loaded graph per store file, kept until a graph write moves its generation; a query reads only that one row.
const graphs = new Map<string, CachedGraph>();
let keepLoaded = false;

/** Lets nearest-vector search walk the graph in this process; a host that serves many queries calls it at start. */
export function keepVectorGraphLoaded(): void {
  keepLoaded = true;
}

function mainFile(db: DatabaseSyncLike): string {
  // SAFETY: PRAGMA database_list returns one row per attached database with these two columns among others.
  const rows = db.prepare('PRAGMA database_list').all() as { name: string; file: string }[];
  return rows.find((r) => r.name === 'main')?.file ?? '';
}

function loadOrNull(db: DatabaseSyncLike): StoredGraph | null {
  try {
    return loadGraph(db);
  } catch (err) {
    // Cached under its generation, so a bad row logs once per write and every query still gets the exact answer.
    log.error(`vector graph unreadable, nearest-vector search scans instead: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
}

function cachedGraph(db: DatabaseSyncLike): CachedGraph | null {
  const generation = graphGeneration(db);
  if (generation === null) return null;
  const file = mainFile(db);
  const hit = file ? graphs.get(file) : undefined;
  if (hit?.generation === generation) return hit;
  const stored = loadOrNull(db);
  const nodeOf = new Map([...(stored?.ids ?? [])].map(([node, id]) => [id, node]));
  const loaded: CachedGraph = { generation: stored?.generation ?? generation, stored, nodeOf };
  if (file) graphs.set(file, loaded);
  return loaded;
}

// One id-only query that reads no vector page: the walk checks the filter in memory and selectivity is exact. A node
// whose vector went or changed dim since the graph write reads as zero, and the re-score drops it.
function admittedNodes(
  db: DatabaseSyncLike,
  nodeOf: ReadonlyMap<string, number>,
  filter: { readonly where: string; readonly params: readonly (string | number)[] },
): Set<number> {
  // SAFETY: the SELECT names exactly the one column read.
  const rows = db.prepare(`SELECT m.id AS id FROM memories m WHERE 1 = 1${filter.where}`)
    .iterate(...filter.params) as Iterable<{ id: string }>;
  const out = new Set<number>();
  for (const { id } of rows) {
    const node = nodeOf.get(id);
    if (node !== undefined) out.add(node);
  }
  return out;
}

// One IN query per expanded node; a gone or resized row reads as zeros, which scores 0.
function batchReader(
  db: DatabaseSyncLike,
  ids: ReadonlyMap<number, string>,
  dim: number,
): (nodes: readonly number[]) => Float32Array[] {
  const statements = new Map<number, ReturnType<DatabaseSyncLike['prepare']>>();
  const zero = new Float32Array(dim);
  const read = (chunk: readonly string[], into: Map<string, Float32Array>): void => {
    let stmt = statements.get(chunk.length);
    if (!stmt) {
      const list = placeholders(chunk.length);
      stmt = db.prepare(`SELECT memory_id, vector FROM memory_vectors WHERE memory_id IN (${list})`);
      statements.set(chunk.length, stmt);
    }
    // SAFETY: the SELECT names exactly these two columns; node:sqlite returns BLOBs as Uint8Array.
    for (const row of stmt.all(...chunk) as { memory_id: string; vector: Uint8Array }[]) {
      if (row.vector.byteLength !== dim * 4) continue;
      // decodeVector's alignment rule; it lives in vector-store.ts, which imports this file.
      const bytes = row.vector.byteOffset % 4 === 0 ? row.vector : new Uint8Array(row.vector);
      into.set(row.memory_id, new Float32Array(bytes.buffer, bytes.byteOffset, dim));
    }
  };
  return (nodes) => {
    const wanted = nodes.flatMap((n) => ids.get(n) ?? []);
    const found = new Map<string, Float32Array>();
    for (let i = 0; i < wanted.length; i += ID_CHUNK) read(wanted.slice(i, i + ID_CHUNK), found);
    return nodes.map((n) => found.get(ids.get(n) ?? '') ?? zero);
  };
}

/** Memory ids the graph finds nearest `query` among rows passing `where`, or null when the exact scan answers. */
export function graphCandidates(
  db: DatabaseSyncLike,
  query: readonly number[],
  k: number,
  filter: { readonly where: string; readonly params: readonly (string | number)[] },
  opts: VectorSearchOptions,
): string[] | null {
  // A one-shot process never repays the load: loading the graph reads every node, as the exact scan reads every vector.
  if (!keepLoaded || envVectorIndexExact()) return null;
  const cached = cachedGraph(db);
  const stored = cached?.stored;
  const minRows = opts.minGraphRows ?? VECTOR_GRAPH_MIN_ROWS;
  if (!cached || !stored || stored.graph.dim !== query.length || stored.graph.nodes.size < minRows) return null;
  const admitted = admittedNodes(db, cached.nodeOf, filter);
  const selectivity = admitted.size / stored.graph.nodes.size;
  if (selectivity < (opts.minSelectivity ?? MIN_SELECTIVITY) || admitted.size < minRows) return null;
  const found = searchGraph(stored.graph, Float32Array.from(query), {
    k,
    ef: opts.ef ?? EF,
    admit: (node) => admitted.has(node),
    visitBudget: VISIT_BUDGET,
    vectorsOf: batchReader(db, stored.ids, query.length),
  });
  if (found.aborted) return null;
  return found.hits.flatMap((h) => stored.ids.get(h.node) ?? []);
}
