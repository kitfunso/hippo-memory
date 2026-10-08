/** Embedding vectors in the `memory_vectors` table: one Float32 BLOB per memory id, plus the one-time import of the old JSON index. */

import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSyncLike } from './db.js';
import { log } from './log.js';

/** Legacy whole-file index; imported once into `memory_vectors`, then kept beside the store as a renamed backup. */
const LEGACY_EMBEDDINGS_FILE = 'embeddings.json';
export const EMBEDDING_MODEL_META_KEY = 'embedding_model';
// Never equal to a real index identity, so the next embed run treats it as a model change and rebuilds every vector.
const QUARANTINED_INDEX_IDENTITY = 'quarantined-corrupt-index';

// No FK to memories: a vector may outlive its row until `hippo embed` prunes it, and the trigger covers deletes.
export const MEMORY_VECTORS_DDL = `
  CREATE TABLE IF NOT EXISTS memory_vectors (
    memory_id TEXT PRIMARY KEY,
    model     TEXT NOT NULL,
    dim       INTEGER NOT NULL,
    vector    BLOB NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS trg_memory_vectors_delete AFTER DELETE ON memories BEGIN
    DELETE FROM memory_vectors WHERE memory_id = old.id;
  END;
`;

const ID_CHUNK = 500;

export function encodeVector(vector: readonly number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

export function decodeVector(blob: Uint8Array): Float32Array {
  // A view needs 4-byte alignment; Buffer#slice is a view too, so copy with the constructor.
  const bytes = blob.byteOffset % 4 === 0 ? blob : new Uint8Array(blob);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Insert or replace vectors, skipping empty or non-finite ones; the caller owns any surrounding transaction. */
export function upsertVectors(db: DatabaseSyncLike, rows: Iterable<readonly [string, readonly number[]]>, model: string): number {
  const stmt = db.prepare('INSERT OR REPLACE INTO memory_vectors (memory_id, model, dim, vector) VALUES (?, ?, ?, ?)');
  let written = 0;
  for (const [id, vector] of rows) {
    if (vector.length === 0 || !vector.every(Number.isFinite)) continue;
    stmt.run(id, model, vector.length, encodeVector(vector));
    written++;
  }
  return written;
}

function inTransaction<T>(db: DatabaseSyncLike, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* keep the original error */ }
    throw err;
  }
}

/** Replace the whole table with `index` in one transaction, as a full rebuild does. */
export function replaceAllVectors(db: DatabaseSyncLike, index: Readonly<Record<string, readonly number[]>>, model: string): void {
  inTransaction(db, () => {
    db.exec('DELETE FROM memory_vectors');
    upsertVectors(db, Object.entries(index), model);
  });
}

/** Drop vectors whose memory row is gone; returns how many went. */
export function deleteOrphanVectors(db: DatabaseSyncLike): number {
  return Number(db.prepare('DELETE FROM memory_vectors WHERE memory_id NOT IN (SELECT id FROM memories)').run().changes ?? 0);
}

/** Vectors for `ids`, or every stored vector when `ids` is omitted. */
export function loadVectors(db: DatabaseSyncLike, ids?: readonly string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const read = (rows: Iterable<unknown>): void => {
    // SAFETY: both SELECTs below name exactly these two columns; node:sqlite returns BLOBs as Uint8Array.
    for (const row of rows as Iterable<{ memory_id: string; vector: Uint8Array }>) out.set(row.memory_id, Array.from(decodeVector(row.vector)));
  };
  if (ids === undefined) {
    read(db.prepare('SELECT memory_id, vector FROM memory_vectors').iterate());
    return out;
  }
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    read(db.prepare(`SELECT memory_id, vector FROM memory_vectors WHERE memory_id IN (${chunk.map(() => '?').join(', ')})`).all(...chunk));
  }
  return out;
}

export function storedVectorIds(db: DatabaseSyncLike): Set<string> {
  // SAFETY: the SELECT names exactly the one column read.
  return new Set((db.prepare('SELECT memory_id FROM memory_vectors').all() as Array<{ memory_id: string }>).map((r) => r.memory_id));
}

export function hasStoredVectors(db: DatabaseSyncLike): boolean {
  return db.prepare('SELECT 1 FROM memory_vectors LIMIT 1').get() !== undefined;
}

export interface VectorMatch {
  id: string;
  score: number;
}

/** A stored vector, decoded. */
export interface VectorRow {
  readonly id: string;
  readonly vector: Float32Array;
}

/** The `k` rows closest to `query` by cosine, best first; ties go to the smaller id, so row order never changes the top k.
 *  The query rounds to Float32 as stored vectors are, and scores add up in float64, so every store that feeds it the same bytes ranks alike. */
export function rankVectorRows(query: readonly number[], rows: Iterable<VectorRow>, k: number): VectorMatch[] {
  const best = bestMatches(query, k);
  if (!best) return [];
  for (const { id, vector } of rows) best.offer(id, vector);
  return best.top;
}

interface BestMatches {
  readonly top: VectorMatch[];
  /** Scores `v` at once, so the caller may overwrite it for the next row. */
  offer(id: string, v: Float32Array): void;
}

// One scoring loop for rows in memory and rows streamed from the store, so the two can never rank apart.
function bestMatches(query: readonly number[], k: number): BestMatches | null {
  if (k <= 0 || query.length === 0) return null;
  const q = Float32Array.from(query);
  let qNorm = 0;
  for (let i = 0; i < q.length; i++) qNorm += q[i] * q[i];
  qNorm = Math.sqrt(qNorm);
  if (qNorm < 1e-10) return null;
  const top: VectorMatch[] = [];
  return {
    top,
    offer(id, v) {
      if (v.length !== q.length) return;
      let dot = 0;
      let norm = 0;
      for (let i = 0; i < v.length; i++) {
        dot += q[i] * v[i];
        norm += v[i] * v[i];
      }
      if (norm < 1e-20) return;
      const score = dot / (qNorm * Math.sqrt(norm));
      if (top.length === k && !beats(score, id, top[k - 1])) return;
      insertSorted(top, { id, score }, k);
    },
  };
}

/** Rows the nearest-vector scan scores between two turns of the event loop. */
const VECTOR_SCAN_CHUNK = 256;

function nextTurn(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/** The `k` stored vectors closest to `query` among `memories m` rows passing `where` (SQL starting with ` AND`).
 *  Filters run before the cut, so rows a caller may not see can never push admitted rows out of the top k. */
export async function topVectorMatches(
  db: DatabaseSyncLike,
  query: readonly number[],
  k: number,
  where: string,
  params: readonly (string | number)[],
): Promise<VectorMatch[]> {
  const best = bestMatches(query, k);
  if (!best) return [];
  // SHORTCUT: brute-force cosine over every admitted vector, a chunk per event-loop turn; latency still grows with rows, fine to ~100k, and an ANN index (sqlite-vec, HNSW) is the upgrade.
  // SAFETY: the SELECT names exactly these two columns; node:sqlite returns BLOBs as Uint8Array.
  const rows = db.prepare(`
    SELECT v.memory_id AS id, v.vector AS vector
    FROM memory_vectors v JOIN memories m ON m.id = v.memory_id
    WHERE v.dim = ?${where}
  `).iterate(query.length, ...params) as Iterable<{ id: string; vector: Uint8Array }>;
  const floats = new Float32Array(query.length);
  const bytes = new Uint8Array(floats.buffer);
  let scored = 0;
  for (const row of rows) {
    // The cursor stays open across the pause: under WAL a reader blocks no writer, and the scan keeps one snapshot.
    if (scored > 0 && scored % VECTOR_SCAN_CHUNK === 0) await nextTurn();
    scored++;
    if (row.vector.byteLength === bytes.byteLength) {
      bytes.set(row.vector);
      best.offer(row.id, floats);
    } else {
      best.offer(row.id, decodeVector(row.vector));
    }
  }
  return best.top;
}

// Ties break on id so the cut is the same on every run.
function beats(score: number, id: string, other: VectorMatch): boolean {
  return score > other.score || (score === other.score && id < other.id);
}

function insertSorted(top: VectorMatch[], m: VectorMatch, k: number): void {
  let i = top.length;
  while (i > 0 && beats(m.score, m.id, top[i - 1])) i--;
  top.splice(i, 0, m);
  if (top.length > k) top.pop();
}

function stamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
}

/** Rename `fp` to `aside`; a rename blocked by an open handle (Windows) falls back to a copy, so the bytes are kept either way. */
function moveAside(fp: string, aside: string): boolean {
  try {
    fs.renameSync(fp, aside);
    return true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return false;
    fs.copyFileSync(fp, aside, fs.constants.COPYFILE_EXCL);
    fs.rmSync(fp, { force: true });
    return true;
  }
}

// The old writer only wrote a plain object of id to number[]; any other shape is corrupt, and non-numeric entries are dropped.
function parseLegacyIndex(raw: string): Map<string, number[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // the caller quarantines the corrupt file and logs it
  }
  if (!(parsed instanceof Object) || Array.isArray(parsed)) return null;
  const index = new Map<string, number[]>();
  for (const [id, value] of Object.entries(parsed)) {
    if (Array.isArray(value) && value.every(Number.isFinite)) index.set(id, value);
  }
  return index;
}

/** Move a legacy `embeddings.json` into `memory_vectors`, then keep the file as `embeddings.json.imported-<stamp>`.
 *  Runs after the migration commits, so the rename never outlives rolled-back rows; a file an older binary writes later imports the same way. */
export function importLegacyEmbeddingIndex(db: DatabaseSyncLike, hippoRoot: string): void {
  const fp = path.join(hippoRoot, LEGACY_EMBEDDINGS_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
  const index = parseLegacyIndex(raw);
  if (!index) {
    const aside = `${fp}.corrupt-${stamp()}`;
    if (!moveAside(fp, aside)) return;
    log.error(`${LEGACY_EMBEDDINGS_FILE} could not be parsed; kept it as ${path.basename(aside)} and the next embed rebuilds the index`, { hippoRoot });
    db.prepare(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(EMBEDDING_MODEL_META_KEY, QUARANTINED_INDEX_IDENTITY);
    return;
  }
  // SAFETY: the SELECT names exactly the one column read.
  const model = (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(EMBEDDING_MODEL_META_KEY) as { value?: string } | undefined)?.value ?? '';
  const written = inTransaction(db, () => upsertVectors(db, index, model));
  const backup = `${fp}.imported-${stamp()}`;
  if (moveAside(fp, backup)) {
    log.info(`moved ${written} vectors from ${LEGACY_EMBEDDINGS_FILE} into the store; the file is kept as ${path.basename(backup)}`, { hippoRoot });
  }
}
