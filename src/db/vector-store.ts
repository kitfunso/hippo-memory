/**
 * Embedding vectors in the `memory_vectors` table: one Float32 BLOB per memory id, plus the
 * one-time import of the old JSON index.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSyncLike } from './index.js';
import { withWriteScope } from './busy.js';
import { errorCode, errorFields, log } from '../base/util/log.js';
import { chunked } from '../base/util/chunked.js';
import { tryParseJson } from '../base/util/json.js';
import { cachedStatement } from './statement-cache.js';
import { META_KEY } from './meta.js';

/** Legacy whole-file index; imported once into `memory_vectors`, then kept beside the store as a
 * renamed backup. */
const LEGACY_EMBEDDINGS_FILE = 'embeddings.json';
export const EMBEDDING_MODEL_META_KEY = META_KEY.embeddingModel;
// Never equal to a real index identity, so the next embed run treats it as a model change and
// rebuilds every vector.
const QUARANTINED_INDEX_IDENTITY = 'quarantined-corrupt-index';

// No FK to memories: a vector may outlive its row until `hippo embed` prunes it, and the trigger
// covers deletes.
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

/** Insert or replace vectors, skipping empty or non-finite ones; the caller owns any surrounding
 * transaction. */
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

// A TEMP table: only the handle that made it sees it, and it goes with that handle, so a crash
// leaves nothing staged.
const STAGED_VECTORS_DDL =
  'CREATE TEMP TABLE IF NOT EXISTS staged_vectors (memory_id TEXT PRIMARY KEY, dim INTEGER NOT NULL, vector BLOB ' +
  'NOT NULL)';

/** An empty staging table on `db` for a full rebuild's vectors; writing it takes no lock on
 * hippo.db. */
export function openVectorStaging(db: DatabaseSyncLike): void {
  db.exec(STAGED_VECTORS_DDL);
  db.exec('DELETE FROM temp.staged_vectors');
}

/** Drops the staging table, for a handle that outlives the rebuild, as a store worker's does. */
export function dropVectorStaging(db: DatabaseSyncLike): void {
  db.exec('DROP TABLE IF EXISTS temp.staged_vectors');
}

/** Stages `rows` on the handle openVectorStaging ran on, skipping empty or non-finite vectors;
 * answers how many. */
export function stageVectors(
  db: DatabaseSyncLike,
  rows: Iterable<readonly [string, readonly number[]]>,
): number {
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

/** Replaces the whole table with the staged vectors under `model` in one transaction, as a full
 * rebuild does. */
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
    'SELECT COUNT(*) AS vectors, COALESCE(SUM(EXISTS (SELECT 1 FROM memories m WHERE m.id = v.memory_id)), 0) AS ' +
      'embedded FROM memory_vectors v',
  ).get() as { vectors: number; embedded: number };
  return { vectors: Number(row.vectors), embedded: Number(row.embedded) };
}

/** Drop vectors whose memory row is gone; returns how many went. */
export function deleteOrphanVectors(db: DatabaseSyncLike): number {
  return Number(
    cachedStatement(
      db,
      'DELETE FROM memory_vectors WHERE memory_id NOT IN (SELECT id FROM memories)',
    ).run().changes ?? 0,
  );
}

// SAFETY: every read cast to this row selects all its keys, and node:sqlite returns BLOBs as
// Uint8Array.
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
    read(
      db
        .prepare('SELECT memory_id, vector FROM memory_vectors')
        .iterate() as Iterable<StoredVectorRow>,
    );
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

/** `loadVectors` for `ids` with no copy: each value views the bytes the store returned for that
 * row. */
export function loadVectorViews(
  db: DatabaseSyncLike,
  ids: readonly string[],
): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  eachStoredVector(db, ids, (id, vector) => out.set(id, vector));
  return out;
}

/** Stored vectors, orphans of deleted memories included. */
export function countStoredVectors(db: DatabaseSyncLike): number {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  return (cachedStatement(db, 'SELECT count(*) AS n FROM memory_vectors').get() as { n: number }).n;
}

/** Float count of the first stored row, from its blob length; the vector is never read. */
export function storedVectorDims(db: DatabaseSyncLike): number | undefined {
  const row = cachedStatement(
    db,
    'SELECT length(vector) AS bytes FROM memory_vectors LIMIT 1',
  ).get() as { bytes: number } | undefined;
  return row === undefined ? undefined : Math.floor(row.bytes / 4);
}

export function hasStoredVectors(db: DatabaseSyncLike): boolean {
  return cachedStatement(db, 'SELECT 1 FROM memory_vectors LIMIT 1').get() !== undefined;
}

function stamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
}

// The codes a rename gets when another process holds the file open (Windows); any other failure
// would fail a copy too.
const RENAME_BLOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Rename `fp` to `aside`; a rename blocked by an open handle falls back to a copy, so the bytes are
 * kept either way.
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
      // The original stays for the next open to retry, so a copy left beside it would pile up one
      // per open.
      fs.rmSync(aside, { force: true });
      throw rmErr;
    }
    return true;
  }
}

// The old writer only wrote a plain object of id to number[]; any other shape is corrupt, and
// non-numeric entries are dropped.
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

/** Move a legacy `embeddings.json` into `memory_vectors`, then keep the file as
 * `embeddings.json.imported-<stamp>`. Runs after the migration commits, so the rename never
 * outlives rolled-back rows; a file an older binary writes later imports the same way.
 */
export function importLegacyEmbeddingIndex(db: DatabaseSyncLike, hippoRoot: string): void {
  const fp = path.join(hippoRoot, LEGACY_EMBEDDINGS_FILE);
  // A stat is cheaper than the failed read this open would otherwise make.
  if (!fs.existsSync(fp)) return;
  let raw: string;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
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
  const written = withWriteScope(db, 'import_legacy_vectors', () =>
    upsertVectors(db, index, model),
  );
  const backup = `${fp}.imported-${stamp()}`;
  if (moveAside(fp, backup)) {
    log.info(
      `moved ${written} vectors from ${LEGACY_EMBEDDINGS_FILE} into the store; the file is kept as ` +
        `${path.basename(backup)}`,
      { hippoRoot },
    );
  }
}
