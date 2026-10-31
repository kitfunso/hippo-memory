// Owns hippo.db's stored vectors and the identity of the model that built them: every read and
// write of the two.
import { getMeta, setMeta, withWriteScope, type DatabaseSyncLike } from '../../../db/index.js';
import type { OnHandle } from '../runtime/open.js';
import {
  embeddingIndexIdentity,
  indexedModel,
  indexNeedsRebuild,
  replacesIndex,
} from '../../../base/embeddings/index-identity.js';
import type { MemoryEntry } from '../../../base/memory/entry.js';
import { tenantAnd } from '../runtime/tenant.js';
import type {
  VectorBackfillQuery,
  VectorWrite,
  VectorWriteResult,
} from '../../../base/ports/store.js';
import {
  EMBEDDING_MODEL_META_KEY,
  countVectors,
  deleteOrphanVectors,
  hasStoredVectors,
  loadVectors,
  loadVectorViews,
  openVectorStaging,
  replaceVectorsWithStaged,
  stageVectors,
  countStoredVectors,
  storedVectorDims,
  upsertVectors,
} from '../../../db/vector-store.js';
import { countAllEntries } from '../entries/entry-reads.js';
import { afterIdAnd, idPageOf } from '../runtime/keyset.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { chunked } from '../../../base/util/chunked.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from '../runtime/rows.js';
import type {
  IdPage,
  IdPageRequest,
  StoredVectorSummary,
  VectorCoverage,
} from '../../../base/records/embedding-index.js';
import type { EmbeddingIndexState } from '../../../base/embeddings/index-identity.js';
import { rethrowIfStoreBlocked } from '../../../base/util/store-blocked.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';

const MAX_BACKFILL_PAGE = 500;

/** hippo.db's index state, the meta row and the EXISTS on one handle. */
export function storedIndexState(db: DatabaseSyncLike): EmbeddingIndexState {
  return {
    storedModel: getMeta(db, EMBEDDING_MODEL_META_KEY, '').trim() || null,
    hasVectors: hasStoredVectors(db),
  };
}

/** Records `identity` as what built the index. */
function saveIndexIdentity(db: DatabaseSyncLike, identity: string): void {
  setMeta(db, EMBEDDING_MODEL_META_KEY, identity);
}

function readStoredEmbeddingModel(on: OnHandle): string | null {
  try {
    return on(storedIndexState).storedModel;
  } catch (err) {
    rethrowIfStoreBlocked(err);
    log.debug(`stored embedding model unreadable: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
}

/** Saves the index identity of provider `model`, versioned by `embeddingIndexIdentity` as the
 * compare side is. */
export function saveStoredEmbeddingModel(on: OnHandle, model: string): void {
  on((db) => {
    saveIndexIdentity(db, embeddingIndexIdentity(model));
  });
}

function resolveIndexedEmbeddingModel(
  on: OnHandle,
  index?: Record<string, number[]>,
): string | null {
  const storedModel = readStoredEmbeddingModel(on);
  if (storedModel) return storedModel;
  return indexedModel({
    storedModel,
    hasVectors: index ? Object.keys(index).length > 0 : on(storedIndexState).hasVectors,
  });
}

export function embeddingModelRequiresReindex(
  on: OnHandle,
  model: string,
  index?: Record<string, number[]>,
): boolean {
  return indexNeedsRebuild(resolveIndexedEmbeddingModel(on, index), model);
}

/** Every stored vector keyed by memory id; `{}` when none. Search reads only the rows it ranks via
 * `readStoredVectorViews`. */
export function listAllVectors(db: DatabaseSyncLike): Record<string, number[]> {
  return Object.fromEntries(loadVectors(db));
}

/** How many vectors are stored and the float count of the first row, with no vector decoded. */
export function storedVectorSummary(db: DatabaseSyncLike): StoredVectorSummary {
  return { vectors: countStoredVectors(db), dims: storedVectorDims(db) };
}

/** Stored vectors for `ids` only, as Float32 views with no copy. */
export function readStoredVectorViews(
  db: DatabaseSyncLike,
  ids: readonly string[],
): Map<string, Float32Array> {
  if (ids.length === 0) return new Map();
  return loadVectorViews(db, ids);
}

/** Vectors staged by page on a handle of their own, so neither the live index nor the caller
 * holds them all. */
export interface VectorRebuild {
  /** Stages one page, skipping empty or non-finite vectors; answers how many it staged. */
  stage(rows: ReadonlyArray<readonly [string, readonly number[]]>): number;
  /** In one transaction, swaps the staged vectors in and records `model` as what built them. */
  commit(model: string): void;
  close(): void;
}

/** A rebuild staged on `db`, a handle of its own that `release` closes, which drops the staging
 * table with it. */
export function beginVectorRebuild(db: DatabaseSyncLike, release: () => void): VectorRebuild {
  openVectorStaging(db);
  return {
    stage: (rows) => stageVectors(db, rows),
    commit: (model) =>
      withWriteScope(db, 'rebuild_vectors', () => {
        replaceVectorsWithStaged(db, model);
        saveIndexIdentity(db, model);
      }),
    close: release,
  };
}

/** How many memories and vectors hippo.db holds, and how many memories have a vector. */
export function vectorCoverage(db: DatabaseSyncLike): VectorCoverage {
  return { memories: countAllEntries(db), ...countVectors(db) };
}

/** Drops the vectors of deleted memories. */
export function pruneOrphanVectors(db: DatabaseSyncLike): void {
  deleteOrphanVectors(db);
}

/** The ids with no vector, in id order, `page.limit` at a time after `page.afterId`: a backfill
 * needs each once. */
export function pendingVectorIds(db: DatabaseSyncLike, page: IdPageRequest): IdPage {
  const after = afterIdAnd(page.afterId);
  const rows = cachedStatement(
    db,
    `SELECT id FROM memories
       WHERE NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id = memories.id)${after.sql}
       ORDER BY id LIMIT ?`,
  ).all(...after.params, page.limit + 1) as Array<{ id: string }>;
  return idPageOf(rows, page.limit);
}

export function entriesWithoutVector(
  db: DatabaseSyncLike,
  query: VectorBackfillQuery,
): MemoryEntry[] {
  if (!Number.isInteger(query.limit)) throw new RangeError('limit must be an integer');
  const limit = Math.max(1, Math.min(query.limit, MAX_BACKFILL_PAGE));
  const tenant = tenantAnd(query.tenantId);
  const rows = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id > ?${tenant.sql}
       AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id = memories.id AND v.model = ?)
     ORDER BY id LIMIT ?`,
  ).all(query.afterId ?? '', ...tenant.params, query.model, limit) as MemoryRow[];
  return rows.map(rowToEntry);
}

function ownedIds(db: DatabaseSyncLike, ids: readonly string[], tenantId: string): Set<string> {
  const owned = new Set<string>();
  for (const chunk of chunked([...new Set(ids)])) {
    const rows = cachedStatement(
      db,
      `SELECT id FROM memories WHERE +tenant_id = ? AND id IN (SELECT value FROM json_each(?))`,
    ).all(tenantId, JSON.stringify(chunk)) as { id: string }[];
    for (const row of rows) owned.add(row.id);
  }
  return owned;
}

export function writeVectors(db: DatabaseSyncLike, write: VectorWrite): VectorWriteResult {
  return withWriteScope(db, 'write_vectors', () => {
    const replaces = replacesIndex(storedIndexState(db), write.model);
    if (replaces && !write.replaceIndex) return { written: 0, modelMismatch: true };
    const owned = ownedIds(
      db,
      write.rows.map((r) => r.memoryId),
      write.tenantId,
    );
    const rows = write.rows.filter(
      (r) => owned.has(r.memoryId) && r.vector.length > 0 && r.vector.every(Number.isFinite),
    );
    if (rows.length === 0) return { written: 0, modelMismatch: false };
    if (replaces) db.exec('DELETE FROM memory_vectors');
    const written = upsertVectors(
      db,
      rows.map((r): [string, readonly number[]] => [r.memoryId, r.vector]),
      write.model,
    );
    setMeta(db, EMBEDDING_MODEL_META_KEY, write.model);
    return { written, modelMismatch: false };
  });
}
