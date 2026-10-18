// Owns hippo.db's stored vectors, the identity of the model that built them, and the particle rows: every read and
// write of the three.
import { getMeta, setMeta, withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import type { OnHandle } from './open.js';
import {
  embeddingIndexIdentity,
  indexedModel,
  indexNeedsRebuild,
  replacesIndex,
} from '../../embeddings/index-identity.js';
import type { MemoryEntry } from '../../core/memory.js';
import type { PhysicsParticle } from '../../core/physics.js';
import { loadPhysicsState, resetAllPhysicsState, savePhysicsState } from '../../db/physics-state.js';
import { initializeParticle } from '../../core/physics.js';
import { float32ToBuffer } from '../../util/vector-codec.js';
import type { VectorBackfillQuery, VectorRowWrite, VectorWrite, VectorWriteResult } from '../port.js';
import {
  EMBEDDING_MODEL_META_KEY,
  deleteOrphanVectors,
  hasStoredVectors,
  loadVectors,
  loadVectorViews,
  replaceAllVectors,
  storedVectorDims,
  storedVectorIds,
  upsertVectors,
} from '../../db/vector-store.js';
import { selectEntriesByIds } from './entry-reads.js';
import { chunked } from '../../util/chunked.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from './rows.js';
import { placeholders } from '../../util/sql.js';
import type { PendingIdsPage, StoredVectorSummary } from '../port/embedding-index.js';
import type { EntryCursor } from '../port/consolidation.js';
import type { EmbeddingIndexState } from '../../embeddings/index-identity.js';
import { rethrowIfSqliteBlocked } from '../../util/sqlite-blocked.js';
import { errorFields, errorMessage, log } from '../../util/log.js';

const MAX_BACKFILL_PAGE = 500;

function embeddingIndexStateOn(db: DatabaseSyncLike): EmbeddingIndexState {
  return {
    storedModel: getMeta(db, EMBEDDING_MODEL_META_KEY, '').trim() || null,
    hasVectors: hasStoredVectors(db),
  };
}

/** hippo.db's index state, the meta row and the EXISTS on one handle. */
export function storedIndexStateAt(db: DatabaseSyncLike): EmbeddingIndexState {
  return embeddingIndexStateOn(db);
}

/** Records `identity` as what built the index. */
export function saveIndexIdentityAt(db: DatabaseSyncLike, identity: string): void {
  setMeta(db, EMBEDDING_MODEL_META_KEY, identity);
}

function loadStoredEmbeddingModel(on: OnHandle): string | null {
  try {
    return on((db) => storedIndexStateAt(db).storedModel);
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.debug(`stored embedding model unreadable: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
}

/** Saves the index identity of provider `model`, versioned by `embeddingIndexIdentity` as the compare side is. */
export function saveStoredEmbeddingModel(on: OnHandle, model: string): void {
  on((db) => {
    saveIndexIdentityAt(db, embeddingIndexIdentity(model));
  });
}

function resolveIndexedEmbeddingModel(on: OnHandle, index?: Record<string, number[]>): string | null {
  const storedModel = loadStoredEmbeddingModel(on);
  if (storedModel) return storedModel;
  return indexedModel({
    storedModel,
    hasVectors: index ? Object.keys(index).length > 0 : on((db) => storedIndexStateAt(db).hasVectors),
  });
}

export function embeddingModelRequiresReindex(on: OnHandle, model: string, index?: Record<string, number[]>): boolean {
  return indexNeedsRebuild(resolveIndexedEmbeddingModel(on, index), model);
}

/** Every stored vector keyed by memory id; `{}` when none. Search reads only the rows it ranks via
 * `loadStoredVectors`. */
export function loadEmbeddingIndexAt(db: DatabaseSyncLike): Record<string, number[]> {
  return Object.fromEntries(loadVectors(db));
}

/** Every stored vector id and the float count of the first row, with no vector decoded. */
export function storedVectorSummaryAt(db: DatabaseSyncLike): StoredVectorSummary {
  return { ids: storedVectorIds(db), dims: storedVectorDims(db) };
}

/** Stored vectors for `ids` only. */
export function loadStoredVectorsAt(db: DatabaseSyncLike, ids: readonly string[]): Map<string, number[]> {
  if (ids.length === 0) return new Map();
  return loadVectors(db, ids);
}

/** `loadStoredVectors` as Float32 views, for a caller that only scores them. */
export function loadStoredVectorViewsAt(db: DatabaseSyncLike, ids: readonly string[]): Map<string, Float32Array> {
  if (ids.length === 0) return new Map();
  return loadVectorViews(db, ids);
}

/** Replace every stored vector with `index`; `model` defaults to the stored index identity. */
export function saveEmbeddingIndexAt(db: DatabaseSyncLike, index: Record<string, number[]>, model?: string): void {
  replaceAllVectors(db, index, model ?? getMeta(db, EMBEDDING_MODEL_META_KEY, ''));
}

/** Inserts or replaces `rows` under `model`, each row its own commit so a failure keeps the rows before it; returns how
 * many it wrote. */
export function saveStoredVectorsAt(
  db: DatabaseSyncLike,
  rows: Iterable<readonly [string, readonly number[]]>,
  model: string,
): number {
  return upsertVectors(db, rows, model);
}

/** Drops the vectors of deleted memories. */
export function pruneOrphanVectorsAt(db: DatabaseSyncLike): void {
  deleteOrphanVectors(db);
}

/** The ids with no vector, oldest first, `page.limit` at a time after `page.after`. */
export function pendingVectorIdsAt(
  db: DatabaseSyncLike,
  page: { readonly limit: number; readonly after?: EntryCursor },
): PendingIdsPage {
  const after = page.after === undefined ? '' : ' AND (created > ? OR (created = ? AND id > ?))';
  const afterArgs = page.after === undefined ? [] : [page.after.created, page.after.created, page.after.id];
  // SAFETY: the SELECT names exactly the two columns read.
  const rows = db
    .prepare(
      `SELECT id, created FROM memories
       WHERE NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id = memories.id)${after}
       ORDER BY created ASC, id ASC LIMIT ?`,
    )
    .all(...afterArgs, page.limit + 1) as Array<{ id: string; created: string }>;
  const kept = rows.slice(0, page.limit);
  const last = kept[kept.length - 1];
  const next = rows.length > page.limit && last ? { created: last.created, id: last.id } : null;
  return { ids: kept.map((r) => r.id), next };
}

export function entriesWithoutVectorAt(db: DatabaseSyncLike, query: VectorBackfillQuery): MemoryEntry[] {
  if (!Number.isInteger(query.limit)) throw new RangeError('limit must be an integer');
  const limit = Math.max(1, Math.min(query.limit, MAX_BACKFILL_PAGE));
  const tenantClause = query.tenantId === undefined ? '' : ' AND tenant_id = ?';
  const tenantArgs = query.tenantId === undefined ? [] : [query.tenantId];
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db
    .prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id > ?${tenantClause}
       AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id = memories.id AND v.model = ?)
     ORDER BY id LIMIT ?`,
    )
    .all(query.afterId ?? '', ...tenantArgs, query.model, limit) as MemoryRow[];
  return rows.map(rowToEntry);
}

function ownedIds(db: DatabaseSyncLike, ids: readonly string[], tenantId: string): Set<string> {
  const owned = new Set<string>();
  for (const chunk of chunked([...new Set(ids)])) {
    // SAFETY: the SELECT names one column, id.
    const rows = db
      .prepare(`SELECT id FROM memories WHERE +tenant_id = ? AND id IN (${placeholders(chunk.length)})`)
      .all(tenantId, ...chunk) as { id: string }[];
    for (const row of rows) owned.add(row.id);
  }
  return owned;
}

// savePhysicsState opens its own transaction and overwrites, so the first particle for a memory is inserted here
// instead.
function insertNewParticles(db: DatabaseSyncLike, rows: readonly VectorRowWrite[]): void {
  const stmt = db.prepare(`
    INSERT INTO memory_physics (memory_id, position_blob, velocity_blob, mass, charge, temperature, last_simulation)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(memory_id) DO NOTHING
  `);
  for (const { memoryId, particle: p } of rows) {
    if (p) {
      stmt.run(
        memoryId,
        float32ToBuffer(p.position),
        float32ToBuffer(p.velocity),
        p.mass,
        p.charge,
        p.temperature,
        p.lastSimulation,
      );
    }
  }
}

export function writeVectorsAt(db: DatabaseSyncLike, write: VectorWrite): VectorWriteResult {
  return withWriteScope(db, 'write_vectors', () => {
    const replaces = replacesIndex(embeddingIndexStateOn(db), write.model);
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
    if (replaces) db.exec('DELETE FROM memory_vectors; DELETE FROM memory_physics;');
    const written = upsertVectors(
      db,
      rows.map((r): [string, readonly number[]] => [r.memoryId, r.vector]),
      write.model,
    );
    insertNewParticles(db, rows);
    setMeta(db, EMBEDDING_MODEL_META_KEY, write.model);
    return { written, modelMismatch: false };
  });
}

/** Every particle stored under `hippoRoot`. */
export function loadStoredParticlesAt(db: DatabaseSyncLike): PhysicsParticle[] {
  return Array.from(loadPhysicsState(db).values());
}

/** The memory id of every stored particle in loadStoredParticlesAt's order, so a caller reads only the particles it
 * keeps. */
export function storedParticleIdsAt(db: DatabaseSyncLike): string[] {
  // SAFETY: the SELECT names exactly the one column read.
  const rows = db.prepare('SELECT memory_id FROM memory_physics ORDER BY rowid').all() as Array<{ memory_id: string }>;
  return rows.map((row) => row.memory_id);
}

/** The stored particles for `ids`, in that order; an id with no particle is skipped. */
export function storedParticlesByIdsAt(db: DatabaseSyncLike, ids: readonly string[]): PhysicsParticle[] {
  if (ids.length === 0) return [];
  const byId = loadPhysicsState(db, [...ids]);
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Writes `particles` over their stored state under `hippoRoot`, as one batch. */
export function saveStoredParticlesAt(db: DatabaseSyncLike, particles: PhysicsParticle[]): void {
  savePhysicsState(db, particles);
}

const PARTICLE_PAGE = 64;

function* entriesInPages(db: DatabaseSyncLike, ids: readonly string[]): Generator<MemoryEntry> {
  for (const page of chunked(ids, PARTICLE_PAGE)) {
    const rows = selectEntriesByIds(db, page);
    for (const id of page) {
      const entry = rows.get(id);
      if (entry) yield entry;
    }
  }
}

/** Replaces every particle under `hippoRoot` with a fresh one per memory in `ids` that has an embedding; returns how
 * many. Rows are read a page at a time. */
export function resetStoredParticlesAt(
  db: DatabaseSyncLike,
  ids: readonly string[],
  embeddingIndex: Record<string, number[]>,
): number {
  return resetAllPhysicsState(db, entriesInPages(db, ids), embeddingIndex);
}

/** Stores a first particle for `entry`, placed at `vector`; a memory that has one keeps it. */
export function seedStoredParticleAt(db: DatabaseSyncLike, entry: MemoryEntry, vector: number[]): void {
  if (!loadPhysicsState(db, [entry.id]).has(entry.id)) savePhysicsState(db, [initializeParticle(entry, vector)]);
}
