// Builds and saves a store's vector graph file off the request path, for the sleep run and for the store worker after
// its own build. A build reads rows a page at a time on a read-only handle, so no writer ever waits on it.
import { errorFields, log } from '../base/util/log.js';
import { openHippoDbReadOnly } from './open.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { cachedStatement } from './statement-cache.js';
import { encodeGraphFile, saveGraphFile } from './vector-graph-file.js';
import { GraphFileIndex } from './vector-graph-reader.js';
import {
  addRow,
  emptyGraphRows,
  type GraphRows,
  ROWS_ABOVE_SQL,
  STALE_SHARE,
  StagedRows,
  type StoredRow,
  storedModel,
  VECTOR_GRAPH_THRESHOLD,
} from './vector-graph-rows.js';
import { storedVectorCount } from './vector-store.js';

const PAGE_ROWS = 1024;
// Longest a build or an encode holds the thread before it gives a turn back.
const SLICE_MS = 10;

/** Gives the thread a turn; false when the work must stop, because its thread is closing or its deadline has passed. */
export type Turn = () => Promise<boolean>;

export function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Calls `step` until it answers true, giving a turn every SLICE_MS; false when `turn` stopped it first. */
async function sliced(step: () => boolean, turn: Turn): Promise<boolean> {
  let slice = performance.now();
  while (!step()) {
    if (performance.now() - slice < SLICE_MS) continue;
    if (!(await turn())) return false;
    slice = performance.now();
  }
  return true;
}

/** Encodes `rows` in slices and saves them; false when `turn` stopped it or another process held the file open. */
async function writeGraphFile(hippoRoot: string, rows: GraphRows, turn: Turn): Promise<boolean> {
  const encoder = encodeGraphFile(rows);
  let bytes: Uint8Array | undefined;
  const encoded = await sliced(() => {
    const step = encoder.next();
    if (step.done) bytes = step.value;
    return step.done === true;
  }, turn);
  return encoded && bytes !== undefined && saveGraphFile(hippoRoot, rows.graph.dim, bytes);
}

function fileDrifted(db: DatabaseSyncLike, hippoRoot: string, dim: number): boolean {
  return new GraphFileIndex(hippoRoot).drift(db, dim) > STALE_SHARE;
}

/** Saves a store worker's freshly built `rows` when the file on disk is missing or has drifted; a failure is one warn
 * line, since reads still have the worker's graph and the scan. */
export async function saveGraphIfDrifted(hippoRoot: string, rows: GraphRows, turn: Turn): Promise<void> {
  try {
    const db = openHippoDbReadOnly(hippoRoot);
    let drifted: boolean;
    try {
      drifted = storedModel(db) === rows.model && fileDrifted(db, hippoRoot, rows.graph.dim);
    } finally {
      db.close();
    }
    if (drifted) await writeGraphFile(hippoRoot, rows, turn);
  } catch (err) {
    log.warn('the vector graph file could not be saved', { hippoRoot, ...errorFields(err) });
  }
}

// One page per statement, so no read holds a snapshot open across the build's turns.
async function readGraphRows(db: DatabaseSyncLike, dim: number, turn: Turn): Promise<GraphRows | undefined> {
  const model = storedModel(db);
  const rows = emptyGraphRows(dim, model);
  const page = cachedStatement(db, `${ROWS_ABOVE_SQL} LIMIT ?`);
  for (let after = 0; ;) {
    const read = page.all(after, dim, PAGE_ROWS) as StoredRow[];
    const staged = new StagedRows(dim);
    for (const row of read) staged.add(row);
    let i = 0;
    const added = await sliced(() => {
      if (i >= staged.length) return true;
      addRow(rows, staged.rowids[i], staged.ids[i], staged.vector(i));
      i++;
      return false;
    }, turn);
    if (!added) return undefined;
    if (read.length < PAGE_ROWS) return storedModel(db) === model ? rows : undefined;
    after = read[read.length - 1].rowid;
  }
}

/** The rows of a new graph when the store holds between the threshold and `maxVectors` vectors and its file has
 * drifted; undefined when no build is due or `turn` stopped it. */
async function buildIfDue(
  db: DatabaseSyncLike,
  hippoRoot: string,
  maxVectors: number,
  turn: Turn,
): Promise<GraphRows | undefined> {
  // A model change rewrites every row, so the newest row has the current length.
  // SAFETY: the read names the one column it is cast to.
  const newest = cachedStatement(db, 'SELECT dim AS dim FROM memory_vectors ORDER BY rowid DESC LIMIT 1').get() as
    | { dim: number }
    | undefined;
  if (newest === undefined) return undefined;
  const stored = storedVectorCount(db);
  if (stored < VECTOR_GRAPH_THRESHOLD || stored > maxVectors || !fileDrifted(db, hippoRoot, newest.dim)) {
    return undefined;
  }
  return readGraphRows(db, newest.dim, turn);
}

export interface GraphFileOptions {
  /** Stored vectors past which no graph is built: config vectorGraph.maxVectors, which bounds the build's heap. */
  readonly maxVectors: number;
  /** Epoch ms by which the build saves or gives up, for a sleep the server stops at a deadline. */
  readonly deadline?: number;
}

/** Builds and saves the store's vector graph file when it is missing or has drifted, so a store with no server still
 * gets one. Never throws: a sleep finishes without it, and reads scan until a later run saves it. */
export async function saveVectorGraphFile(hippoRoot: string, opts: GraphFileOptions): Promise<void> {
  const started = Date.now();
  const turn: Turn = async () => {
    await nextTurn();
    if (opts.deadline === undefined || Date.now() < opts.deadline) return true;
    log.info("the vector graph file was not saved: the sleep's deadline came first", { hippoRoot });
    return false;
  };
  try {
    const db = openHippoDbReadOnly(hippoRoot);
    try {
      const rows = await buildIfDue(db, hippoRoot, opts.maxVectors, turn);
      if (rows === undefined || !(await writeGraphFile(hippoRoot, rows, turn))) return;
      log.info(`saved the vector graph file of ${rows.ids.length} vectors of length ${rows.graph.dim}`, {
        hippoRoot,
        buildMs: Date.now() - started,
      });
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn('the vector graph file could not be saved, so reads scan until a later sleep saves it', {
      hippoRoot,
      ...errorFields(err),
    });
  }
}
