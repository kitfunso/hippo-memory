// Owns hippo.db's stored vectors, the identity of the model that built them, and the particle rows: every read and write of the three.
import { getMeta, setMeta, withWriteScope, type DatabaseSyncLike } from '../db/index.js';
import { onHandle } from './open.js';
import { DEFAULT_EMBEDDING_MODEL } from './embeddings/local.js';
import type { MemoryEntry } from '../core/memory.js';
import type { PhysicsParticle } from '../core/physics.js';
import { float32ToBuffer, initializeParticle, loadPhysicsState, resetAllPhysicsState, savePhysicsState } from '../db/physics-state.js';
import type { VectorBackfillQuery, VectorRowWrite, VectorWrite, VectorWriteResult } from './port.js';
import {
  EMBEDDING_MODEL_META_KEY, deleteOrphanVectors, hasStoredVectors, loadVectors, loadVectorViews, replaceAllVectors, storedVectorDims, storedVectorIds,
  upsertVectors,
} from '../db/vector-store.js';
import { chunked, selectEntriesByIds } from './entry-reads.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from './rows.js';

const MAX_BACKFILL_PAGE = 500;

/** What a store's vector index was built by: the stored identity, and whether any vector exists. */
export interface EmbeddingIndexState {
  readonly storedModel: string | null;
  readonly hasVectors: boolean;
}

/** The model the index was built by: the stored identity, else the default model when vectors exist. */
export function indexedModel(state: EmbeddingIndexState): string | null {
  return state.storedModel ?? (state.hasVectors ? DEFAULT_EMBEDDING_MODEL : null);
}

/** Whether a vector write under the index identity `model` first drops the stored index, which another model built. */
export function replacesIndex(state: EmbeddingIndexState, model: string): boolean {
  const indexed = indexedModel(state);
  return indexed !== null && indexed !== model;
}

function embeddingIndexStateOn(db: DatabaseSyncLike): EmbeddingIndexState {
  return {
    storedModel: getMeta(db, EMBEDDING_MODEL_META_KEY, '').trim() || null,
    hasVectors: hasStoredVectors(db),
  };
}

/** hippo.db's index state, the meta row and the EXISTS on one handle. */
export function storedIndexState(hippoRoot: string): EmbeddingIndexState {
  return onHandle(hippoRoot, (db) => {
    return embeddingIndexStateOn(db);
  });
}

/** Records `identity` as what built the index under `hippoRoot`. */
export function saveIndexIdentity(hippoRoot: string, identity: string): void {
  onHandle(hippoRoot, (db) => {
    setMeta(db, EMBEDDING_MODEL_META_KEY, identity);
  });
}

/** Every stored vector keyed by memory id; `{}` when none. Search reads only the rows it ranks via `loadStoredVectors`. */
export function loadEmbeddingIndex(hippoRoot: string): Record<string, number[]> {
  return onHandle(hippoRoot, (db) => {
    return Object.fromEntries(loadVectors(db));
  });
}

export interface StoredVectorSummary {
  readonly ids: Set<string>;
  readonly dims: number | undefined;
}

/** Every stored vector id and the float count of the first row, with no vector decoded. */
export function storedVectorSummary(hippoRoot: string): StoredVectorSummary {
  return onHandle(hippoRoot, (db) => {
    return { ids: storedVectorIds(db), dims: storedVectorDims(db) };
  });
}

/** Stored vectors for `ids` only. */
export function loadStoredVectors(hippoRoot: string, ids: readonly string[]): Map<string, number[]> {
  if (ids.length === 0) return new Map();
  return onHandle(hippoRoot, (db) => {
    return loadVectors(db, ids);
  });
}

/** `loadStoredVectors` as Float32 views, for a caller that only scores them. */
export function loadStoredVectorViews(hippoRoot: string, ids: readonly string[]): Map<string, Float32Array> {
  if (ids.length === 0) return new Map();
  return onHandle(hippoRoot, (db) => {
    return loadVectorViews(db, ids);
  });
}

/** Replace every stored vector with `index`; `model` defaults to the stored index identity. */
export function saveEmbeddingIndex(hippoRoot: string, index: Record<string, number[]>, model?: string): void {
  onHandle(hippoRoot, (db) => {
    replaceAllVectors(db, index, model ?? getMeta(db, EMBEDDING_MODEL_META_KEY, ''));
  });
}

/** Inserts or replaces `rows` under `model`, each row its own commit so a failure keeps the rows before it; returns how many it wrote. */
export function saveStoredVectors(hippoRoot: string, rows: Iterable<readonly [string, readonly number[]]>, model: string): number {
  return onHandle(hippoRoot, (db) => {
    return upsertVectors(db, rows, model);
  });
}

/** Drops the vectors of deleted memories under `hippoRoot`, then returns the ids that still have one. */
export function pruneStoredVectors(hippoRoot: string): Set<string> {
  return onHandle(hippoRoot, (db) => {
    deleteOrphanVectors(db);
    return storedVectorIds(db);
  });
}

export function entriesWithoutVectorAt(db: DatabaseSyncLike, query: VectorBackfillQuery): MemoryEntry[] {
  if (!Number.isInteger(query.limit)) throw new RangeError('limit must be an integer');
  const limit = Math.max(1, Math.min(query.limit, MAX_BACKFILL_PAGE));
  const tenantClause = query.tenantId === undefined ? '' : ' AND tenant_id = ?';
  const tenantArgs = query.tenantId === undefined ? [] : [query.tenantId];
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db.prepare(
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id > ?${tenantClause}
       AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id = memories.id AND v.model = ?)
     ORDER BY id LIMIT ?`,
  ).all(query.afterId ?? '', ...tenantArgs, query.model, limit) as MemoryRow[];
  return rows.map(rowToEntry);
}

function ownedIds(db: DatabaseSyncLike, ids: readonly string[], tenantId: string): Set<string> {
  const owned = new Set<string>();
  for (const chunk of chunked([...new Set(ids)])) {
    // SAFETY: the SELECT names one column, id.
    const rows = db.prepare(`SELECT id FROM memories WHERE +tenant_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`).all(
      tenantId,
      ...chunk
    ) as { id: string }[];
    for (const row of rows) owned.add(row.id);
  }
  return owned;
}

// savePhysicsState opens its own transaction and overwrites, so the first particle for a memory is inserted here instead.
function insertNewParticles(db: DatabaseSyncLike, rows: readonly VectorRowWrite[]): void {
  const stmt = db.prepare(`
    INSERT INTO memory_physics (memory_id, position_blob, velocity_blob, mass, charge, temperature, last_simulation)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(memory_id) DO NOTHING
  `);
  for (const { memoryId, particle: p } of rows) {
    if (p) stmt.run(memoryId, float32ToBuffer(p.position), float32ToBuffer(p.velocity), p.mass, p.charge, p.temperature, p.lastSimulation);
  }
}

export function writeVectorsAt(db: DatabaseSyncLike, write: VectorWrite): VectorWriteResult {
  return withWriteScope(db, 'write_vectors', () => {
    const replaces = replacesIndex(embeddingIndexStateOn(db), write.model);
    if (replaces && !write.replaceIndex) return { written: 0, modelMismatch: true };
    const owned = ownedIds(db, write.rows.map((r) => r.memoryId), write.tenantId);
    const rows = write.rows.filter((r) => owned.has(r.memoryId) && r.vector.length > 0 && r.vector.every(Number.isFinite));
    if (rows.length === 0) return { written: 0, modelMismatch: false };
    if (replaces) db.exec('DELETE FROM memory_vectors; DELETE FROM memory_physics;');
    const written = upsertVectors(db, rows.map((r): [string, readonly number[]] => [r.memoryId, r.vector]), write.model);
    insertNewParticles(db, rows);
    setMeta(db, EMBEDDING_MODEL_META_KEY, write.model);
    return { written, modelMismatch: false };
  });
}

/** Every particle stored under `hippoRoot`. */
export function loadStoredParticles(hippoRoot: string): PhysicsParticle[] {
  return onHandle(hippoRoot, (db) => {
    return Array.from(loadPhysicsState(db).values());
  });
}

/** Writes `particles` over their stored state under `hippoRoot`, as one batch. */
export function saveStoredParticles(hippoRoot: string, particles: PhysicsParticle[]): void {
  onHandle(hippoRoot, (db) => {
    savePhysicsState(db, particles);
  });
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

/** Replaces every particle under `hippoRoot` with a fresh one per memory in `ids` that has an embedding; returns how many. Rows are read a page at a time. */
export function resetStoredParticles(hippoRoot: string, ids: readonly string[], embeddingIndex: Record<string, number[]>): number {
  return onHandle(hippoRoot, (db) => {
    return resetAllPhysicsState(db, entriesInPages(db, ids), embeddingIndex);
  });
}

/** Stores a first particle for `entry`, placed at `vector`; a memory that has one keeps it. */
export function seedStoredParticle(hippoRoot: string, entry: MemoryEntry, vector: number[]): void {
  onHandle(hippoRoot, (db) => {
    if (!loadPhysicsState(db, [entry.id]).has(entry.id)) savePhysicsState(db, [initializeParticle(entry, vector)]);
  });
}
