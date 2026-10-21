/**
 * Embedding vectors in the `memory_vectors` table: one Float32 BLOB per memory id, plus the one-time import of the old
 * JSON index.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSyncLike } from './index.js';
import { withWriteScope } from './busy.js';
import { errorCode, errorFields, log } from '../base/util/log.js';
import { chunked } from '../base/util/chunked.js';
import { placeholders } from './sql.js';
import { tryParseJson } from '../base/util/json.js';
import { cachedStatement } from './statement-cache.js';

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

export function encodeVector(vector: readonly number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

export function decodeVector(blob: Uint8Array): Float32Array {
  // A view needs 4-byte alignment; Buffer#slice is a view too, so copy with the constructor.
  const bytes = blob.byteOffset % 4 === 0 ? blob : new Uint8Array(blob);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Insert or replace vectors, skipping empty or non-finite ones; the caller owns any surrounding transaction. */
export function upsertVectors(
  db: DatabaseSyncLike,
  rows: Iterable<readonly [string, readonly number[]]>,
  model: string,
): number {
  const stmt = cachedStatement(
    db,
    'INSERT OR REPLACE INTO memory_vectors (memory_id, model, dim, vector) VALUES (?, ?, ?, ?)',
  );
  let written = 0;
  for (const [id, vector] of rows) {
    if (vector.length === 0 || !vector.every(Number.isFinite)) continue;
    stmt.run(id, model, vector.length, encodeVector(vector));
    written++;
  }
  return written;
}

// A TEMP table: only the handle that made it sees it, and it goes with that handle, so a crash leaves nothing staged.
const STAGED_VECTORS_DDL =
  'CREATE TEMP TABLE IF NOT EXISTS staged_vectors ' +
  '(memory_id TEXT PRIMARY KEY, dim INTEGER NOT NULL, vector BLOB NOT NULL)';

/** An empty staging table on `db` for a full rebuild's vectors; writing it takes no lock on hippo.db. */
export function openVectorStaging(db: DatabaseSyncLike): void {
  db.exec(STAGED_VECTORS_DDL);
  db.exec('DELETE FROM temp.staged_vectors');
}

/** Drops the staging table, for a handle that outlives the rebuild, as a store worker's does. */
export function dropVectorStaging(db: DatabaseSyncLike): void {
  db.exec('DROP TABLE IF EXISTS temp.staged_vectors');
}

/** Stages `rows` on the handle openVectorStaging ran on, skipping empty or non-finite vectors; answers how many. */
export function stageVectors(db: DatabaseSyncLike, rows: Iterable<readonly [string, readonly number[]]>): number {
  const stmt = cachedStatement(
    db,
    'INSERT OR REPLACE INTO temp.staged_vectors (memory_id, dim, vector) VALUES (?, ?, ?)',
  );
  let staged = 0;
  for (const [id, vector] of rows) {
    if (vector.length === 0 || !vector.every(Number.isFinite)) continue;
    stmt.run(id, vector.length, encodeVector(vector));
    staged++;
  }
  return staged;
}

/** Replaces the whole table with the staged vectors under `model` in one transaction, as a full rebuild does. */
export function replaceVectorsWithStaged(db: DatabaseSyncLike, model: string): void {
  withWriteScope(db, 'replace_all_vectors', () => {
    db.exec('DELETE FROM memory_vectors');
    cachedStatement(
      db,
      'INSERT INTO memory_vectors (memory_id, model, dim, vector) ' +
        'SELECT memory_id, ?, dim, vector FROM temp.staged_vectors',
    ).run(model);
  });
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
export interface VectorCounts {
  readonly vectors: number;
  /** Vectors whose memory row still exists. */
  readonly embedded: number;
}

export function countVectors(db: DatabaseSyncLike): VectorCounts {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const row = cachedStatement(
    db,
    'SELECT COUNT(*) AS vectors, ' +
      'COALESCE(SUM(EXISTS (SELECT 1 FROM memories m WHERE m.id = v.memory_id)), 0) AS embedded ' +
      'FROM memory_vectors v',
  ).get() as { vectors: number; embedded: number };
  return { vectors: Number(row.vectors), embedded: Number(row.embedded) };
}

/** Drop vectors whose memory row is gone; returns how many went. */
export function deleteOrphanVectors(db: DatabaseSyncLike): number {
  return Number(
    cachedStatement(db, 'DELETE FROM memory_vectors WHERE memory_id NOT IN (SELECT id FROM memories)').run().changes ??
      0,
  );
}

// SAFETY: every read cast to this row selects all its keys, and node:sqlite returns BLOBs as Uint8Array.
type StoredVectorRow = { memory_id: string; vector: Uint8Array };

// One read behind the copied and the viewed shape, so the two can never return different rows.
function eachStoredVector(
  db: DatabaseSyncLike,
  ids: readonly string[] | undefined,
  take: (id: string, vector: Float32Array) => void,
): void {
  const read = (rows: Iterable<StoredVectorRow>): void => {
    for (const row of rows) {
      take(row.memory_id, decodeVector(row.vector));
    }
  };
  if (ids === undefined) {
    read(db.prepare('SELECT memory_id, vector FROM memory_vectors').iterate() as Iterable<StoredVectorRow>);
    return;
  }
  const unique = [...new Set(ids)];
  for (const chunk of chunked(unique)) {
    read(
      cachedStatement(
        db,
        `SELECT memory_id, vector FROM memory_vectors WHERE memory_id IN (SELECT value FROM json_each(?))`,
      ).all(JSON.stringify(chunk)) as StoredVectorRow[],
    );
  }
}

/** Vectors for `ids`, or every stored vector when `ids` is omitted. */
export function loadVectors(db: DatabaseSyncLike, ids?: readonly string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  eachStoredVector(db, ids, (id, vector) => out.set(id, Array.from(vector)));
  return out;
}

/** `loadVectors` for `ids` with no copy: each value views the bytes the store returned for that row. */
export function loadVectorViews(db: DatabaseSyncLike, ids: readonly string[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  eachStoredVector(db, ids, (id, vector) => out.set(id, vector));
  return out;
}

/** Stored vectors, orphans of deleted memories included. */
export function storedVectorCount(db: DatabaseSyncLike): number {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  return (cachedStatement(db, 'SELECT count(*) AS n FROM memory_vectors').get() as { n: number }).n;
}

/** Float count of the first stored row, from its blob length; the vector is never read. */
export function storedVectorDims(db: DatabaseSyncLike): number | undefined {
  const row = cachedStatement(db, 'SELECT length(vector) AS bytes FROM memory_vectors LIMIT 1').get() as
    | { bytes: number }
    | undefined;
  return row === undefined ? undefined : Math.floor(row.bytes / 4);
}

export function hasStoredVectors(db: DatabaseSyncLike): boolean {
  return cachedStatement(db, 'SELECT 1 FROM memory_vectors LIMIT 1').get() !== undefined;
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

/**
 * The `k` rows closest to `query` by cosine, best first; ties go to the smaller id, so row order never changes the top
 * k.
 * The query rounds to Float32 as stored vectors are, and scores add up in float64, so every store that feeds it the
 * same bytes ranks alike.
 */
export function rankVectorRows(query: readonly number[], rows: Iterable<VectorRow>, k: number): VectorMatch[] {
  const best = bestMatches(query, k);
  if (!best) return [];
  for (const { id, vector } of rows) best.offer(id, vector);
  return best.top();
}

interface BestMatches {
  /** The kept matches, best first. */
  top(): VectorMatch[];
  /** Scores `v` at once, so the caller may overwrite it for the next row. */
  offer(id: string, v: Float32Array): void;
}

// One scoring loop for rows in memory and rows paged from the store, so the two can never rank apart.
function bestMatches(query: readonly number[], k: number): BestMatches | null {
  if (k <= 0 || query.length === 0) return null;
  const q = Float32Array.from(query);
  let qNorm = 0;
  for (let i = 0; i < q.length; i++) qNorm += q[i] * q[i];
  qNorm = Math.sqrt(qNorm);
  if (qNorm < 1e-10) return null;
  const kept = new MatchHeap(k);
  return {
    top: () => kept.sorted(),
    offer(id, v) {
      if (v.length !== q.length) return;
      let dot = 0;
      let norm = 0;
      for (let i = 0; i < v.length; i++) {
        dot += q[i] * v[i];
        norm += v[i] * v[i];
      }
      if (norm < 1e-20) return;
      kept.offer({ id, score: dot / (qNorm * Math.sqrt(norm)) });
    },
  };
}

/** At most `k` matches with the worst at the root, so a row that makes the cut costs one log k sift. */
class MatchHeap {
  readonly #k: number;
  readonly #heap: VectorMatch[] = [];

  constructor(k: number) {
    this.#k = k;
  }

  offer(m: VectorMatch): void {
    const heap = this.#heap;
    if (heap.length < this.#k) {
      heap.push(m);
      this.#siftUp(heap.length - 1);
    } else if (beats(m.score, m.id, heap[0])) {
      heap[0] = m;
      this.#siftDown(0);
    }
  }

  sorted(): VectorMatch[] {
    return [...this.#heap].sort((a, b) => (beats(a.score, a.id, b) ? -1 : beats(b.score, b.id, a) ? 1 : 0));
  }

  #worse(i: number, j: number): boolean {
    return beats(this.#heap[j].score, this.#heap[j].id, this.#heap[i]);
  }

  #swap(i: number, j: number): void {
    const heap = this.#heap;
    [heap[i], heap[j]] = [heap[j], heap[i]];
  }

  #siftUp(i: number): void {
    for (let parent = (i - 1) >> 1; i > 0 && this.#worse(i, parent); i = parent, parent = (i - 1) >> 1) {
      this.#swap(i, parent);
    }
  }

  #siftDown(i: number): void {
    for (;;) {
      const left = 2 * i + 1;
      let worst = i;
      if (left < this.#heap.length && this.#worse(left, worst)) worst = left;
      if (left + 1 < this.#heap.length && this.#worse(left + 1, worst)) worst = left + 1;
      if (worst === i) return;
      this.#swap(i, worst);
      i = worst;
    }
  }
}

/** Rows the nearest-vector scan reads in one statement and scores before it yields a turn of the event loop. */
const VECTOR_SCAN_PAGE = 1024;

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Proposes a query's nearest rows from an index in memory; undefined when it cannot answer, so the caller scans. */
export interface VectorIndex {
  matches(
    db: DatabaseSyncLike,
    query: readonly number[],
    k: number,
    where: string,
    params: readonly (string | number)[],
  ): VectorMatch[] | undefined;
}

/** The admitted vectors of length `?` among `memories m` rows passing `where`, limited to `idCount` bound memory ids
 * when given. The scan and the graph's read share it, so the graph can never admit a row the scan would not. */
export function admittedVectorsSql(where: string, idCount = 0): string {
  const among = idCount > 0 ? `v.memory_id IN (${placeholders(idCount)}) AND ` : '';
  // CROSS JOIN keeps memory_vectors the outer loop, so a page walks its key in order instead of sorting every row.
  return `SELECT v.memory_id AS id, v.vector AS vector
    FROM memory_vectors v CROSS JOIN memories m ON m.id = v.memory_id
    WHERE ${among}v.dim = ?${where}`;
}

/** What the nearest-vector reads ask: `k` rows closest to `query` among `memories m` rows passing `where`. */
export interface VectorMatchQuery {
  query: readonly number[];
  k: number;
  where: string;
  params: readonly (string | number)[];
}

export interface TopVectorMatchesOptions extends VectorMatchQuery {
  index?: VectorIndex;
}

/** The `k` stored vectors closest to `query` among `memories m` rows passing `where` (SQL starting with ` AND`).
 *  Filters run before the cut, so rows a caller may not see can never push admitted rows out of the top k. */
export async function topVectorMatches(db: DatabaseSyncLike, options: TopVectorMatchesOptions): Promise<VectorMatch[]> {
  const { query, k, where, params, index } = options;
  const best = bestMatches(query, k);
  if (!best) return [];
  // A store worker that holds a graph answers from it; any other read scans every admitted vector, a page at a time.
  const proposed = index?.matches(db, query, k, where, params);
  if (proposed !== undefined) return proposed;
  // Keyed on memory_id: a vector re-embedded between two pages keeps its id, so no page returns a row twice.
  const page = cachedStatement(db, `${admittedVectorsSql(where)} AND v.memory_id > ? ORDER BY v.memory_id LIMIT ?`);
  const floats = new Float32Array(query.length);
  const bytes = new Uint8Array(floats.buffer);
  let after = '';
  for (;;) {
    // SAFETY: node:sqlite returns BLOBs as Uint8Array.
    const rows = page.all(query.length, ...params, after, VECTOR_SCAN_PAGE) as Array<{
      id: string;
      vector: Uint8Array;
    }>;
    for (const row of rows) {
      if (row.vector.byteLength === bytes.byteLength) {
        bytes.set(row.vector);
        best.offer(row.id, floats);
      } else {
        best.offer(row.id, decodeVector(row.vector));
      }
    }
    if (rows.length < VECTOR_SCAN_PAGE) return best.top();
    after = rows[rows.length - 1].id;
    await nextTurn();
  }
}

// Ties break on id so the cut is the same on every run.
function beats(score: number, id: string, other: VectorMatch): boolean {
  return score > other.score || (score === other.score && id < other.id);
}

function stamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
}

// The codes a rename gets when another process holds the file open (Windows); any other failure would fail a copy too.
const RENAME_BLOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Rename `fp` to `aside`; a rename blocked by an open handle falls back to a copy, so the bytes are kept either way.
 */
function moveAside(fp: string, aside: string): boolean {
  try {
    fs.renameSync(fp, aside);
    return true;
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') return false;
    if (!RENAME_BLOCKED_CODES.has(code)) throw err;
    log.warn(`could not rename ${path.basename(fp)} aside (${code}); copying it instead`, {
      path: fp,
      ...errorFields(err),
    });
    fs.copyFileSync(fp, aside, fs.constants.COPYFILE_EXCL);
    try {
      fs.rmSync(fp, { force: true });
    } catch (rmErr) {
      // The original stays for the next open to retry, so a copy left beside it would pile up one per open.
      fs.rmSync(aside, { force: true });
      throw rmErr;
    }
    return true;
  }
}

// The old writer only wrote a plain object of id to number[]; any other shape is corrupt, and non-numeric entries are
// dropped.
function parseLegacyIndex(raw: string): Map<string, number[]> | null {
  // Text that is not JSON reads as corrupt: the caller quarantines the file and logs it.
  const parsed: unknown = tryParseJson(raw);
  if (!(parsed instanceof Object) || Array.isArray(parsed)) return null;
  const index = new Map<string, number[]>();
  for (const [id, value] of Object.entries(parsed)) {
    if (Array.isArray(value) && value.every(Number.isFinite)) index.set(id, value);
  }
  return index;
}

/** Move a legacy `embeddings.json` into `memory_vectors`, then keep the file as `embeddings.json.imported-<stamp>`.
 * Runs after the migration commits, so the rename never outlives rolled-back rows; a file an older binary writes later
 * imports the same way.
 */
export function importLegacyEmbeddingIndex(db: DatabaseSyncLike, hippoRoot: string): void {
  const fp = path.join(hippoRoot, LEGACY_EMBEDDINGS_FILE);
  // A stat is cheaper than the failed read this open would otherwise make.
  if (!fs.existsSync(fp)) return;
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
    log.error(
      `${LEGACY_EMBEDDINGS_FILE} could not be parsed; kept it as ${path.basename(aside)} and the next embed rebuilds ` +
        `the index`,
      { hippoRoot },
    );
    cachedStatement(
      db,
      `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(EMBEDDING_MODEL_META_KEY, QUARANTINED_INDEX_IDENTITY);
    return;
  }
  const model =
    (
      cachedStatement(db, `SELECT value FROM meta WHERE key = ?`).get(EMBEDDING_MODEL_META_KEY) as
        | { value?: string }
        | undefined
    )?.value ?? '';
  const written = withWriteScope(db, 'import_legacy_vectors', () => upsertVectors(db, index, model));
  const backup = `${fp}.imported-${stamp()}`;
  if (moveAside(fp, backup)) {
    log.info(
      `moved ${written} vectors from ${LEGACY_EMBEDDINGS_FILE} into the store; the file is kept as ` +
        `${path.basename(backup)}`,
      { hippoRoot },
    );
  }
}
