// The path choice for one nearest-vector query: the graph walk with the caller's filter inside it, or null for the
// exact scan. A filter that admits too few rows, a small graph or an aborted walk all fall back to the scan.
import type { DatabaseSyncLike } from './sqlite.js';
import { envVectorIndexExact } from '../util/env.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { searchGraph } from '../util/vector-graph.js';
import {
  graphGeneration,
  loadGraph,
  VECTOR_GRAPH_MIN_ROWS,
  vectorReader,
  type StoredGraph,
} from './vector-graph-rows.js';

/** Knobs for tests and the bench; recall passes none. */
export interface VectorSearchOptions {
  /** Fewest graph nodes, and estimated admitted rows, before the graph answers; default 20,000. */
  readonly minGraphRows?: number;
  /** Replaces the search width the filter's selectivity sets. */
  readonly ef?: number;
}

const SAMPLE_SIZE = 200;
const MIN_SELECTIVITY = 0.1;
const BASE_EF = 128;
const MAX_EF = 512;
const VISIT_BUDGET = 20_000;

interface CachedGraph {
  readonly generation: number;
  readonly stored: StoredGraph | null;
  readonly sample: readonly number[];
}

// One loaded graph per store file, kept until a graph write moves its generation; a query reads only that one row.
const graphs = new Map<string, CachedGraph>();

function mainFile(db: DatabaseSyncLike): string {
  // SAFETY: PRAGMA database_list returns one row per attached database with these two columns among others.
  const rows = db.prepare('PRAGMA database_list').all() as { name: string; file: string }[];
  return rows.find((r) => r.name === 'main')?.file ?? '';
}

function sampleOf(stored: StoredGraph | null): number[] {
  if (!stored) return [];
  const nodes = [...stored.graph.nodes.keys()].sort((a, b) => a - b);
  const stride = Math.max(1, Math.floor(nodes.length / SAMPLE_SIZE));
  return nodes.filter((_, i) => i % stride === 0).slice(0, SAMPLE_SIZE);
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
  const loaded: CachedGraph = { generation: stored?.generation ?? generation, stored, sample: sampleOf(stored) };
  if (file) graphs.set(file, loaded);
  return loaded;
}

function admitter(
  db: DatabaseSyncLike,
  ids: ReadonlyMap<number, string>,
  dim: number,
  where: string,
  params: readonly (string | number)[],
): (node: number) => boolean {
  const stmt = db.prepare(
    `SELECT 1 FROM memories m JOIN memory_vectors v ON v.memory_id = m.id WHERE m.id = ? AND v.dim = ?${where}`,
  );
  const seen = new Map<number, boolean>();
  return (node) => {
    let ok = seen.get(node);
    if (ok === undefined) {
      const id = ids.get(node);
      ok = id !== undefined && stmt.get(id, dim, ...params) !== undefined;
      seen.set(node, ok);
    }
    return ok;
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
  if (envVectorIndexExact()) return null;
  const cached = cachedGraph(db);
  const stored = cached?.stored;
  const minRows = opts.minGraphRows ?? VECTOR_GRAPH_MIN_ROWS;
  if (!cached || !stored || stored.graph.dim !== query.length || stored.graph.nodes.size < minRows) return null;
  const admit = admitter(db, stored.ids, query.length, filter.where, filter.params);
  const selectivity = cached.sample.filter(admit).length / Math.max(1, cached.sample.length);
  if (selectivity < MIN_SELECTIVITY || stored.graph.nodes.size * selectivity < minRows) return null;
  const found = searchGraph(stored.graph, Float32Array.from(query), {
    k,
    ef: opts.ef ?? Math.min(Math.ceil(BASE_EF / selectivity), MAX_EF),
    admit,
    visitBudget: VISIT_BUDGET,
    vectorOf: vectorReader(db, stored.ids, query.length),
  });
  if (found.aborted) return null;
  return found.hits.flatMap((h) => stored.ids.get(h.node) ?? []);
}
