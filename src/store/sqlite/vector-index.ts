// Owns hippo.db's stored vectors, the identity of the model that built them, and the particle rows: every read and
// write of the three.
import { getMeta, setMeta, withReadSnapshot, withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { physicsSpeedSum } from '../../db/physics-state.js';
import type { OnHandle } from './open.js';
import {
  embeddingIndexIdentity,
  indexedModel,
  indexNeedsRebuild,
  replacesIndex,
} from '../../base/embeddings/index-identity.js';
import { strengthOptionsOf, type LossAversion, type MemoryEntry } from '../../base/memory/memory.js';
import type { PhysicsParticle } from '../../base/rank/physics.js';
import {
  loadPhysicsState,
  resetPhysicsFromSeeds,
  savePhysicsState,
  type ParticleSeed,
} from '../../db/physics-state.js';
import { initializeParticle } from '../../base/rank/physics.js';
import { float32ToBuffer } from '../../base/util/vector-codec.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { tenantAnd } from './tenant.js';
import type { VectorBackfillQuery, VectorRowWrite, VectorWrite, VectorWriteResult } from '../port.js';
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
  storedVectorCount,
  storedVectorDims,
  upsertVectors,
} from '../../db/vector-store.js';
import { countAllEntriesAt, loadEntryIdsByIdAt, selectEntriesByIds } from './entry-reads.js';
import { afterIdAnd, idPageOf } from './keyset.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { chunked } from '../../base/util/chunked.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from './rows.js';
import type {
  IdPage,
  IdPageRequest,
  ParticleStats,
  StoredVectorSummary,
  VectorCoverage,
} from '../port/embedding-index.js';
import type { EmbeddingIndexState } from '../../base/embeddings/index-identity.js';
import { rethrowIfSqliteBlocked } from '../../base/util/sqlite-blocked.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';

const MAX_BACKFILL_PAGE = 500;

/** hippo.db's index state, the meta row and the EXISTS on one handle. */
export function storedIndexStateAt(db: DatabaseSyncLike): EmbeddingIndexState {
  return {
    storedModel: getMeta(db, EMBEDDING_MODEL_META_KEY, '').trim() || null,
    hasVectors: hasStoredVectors(db),
  };
}

/** Records `identity` as what built the index. */
function saveIndexIdentityAt(db: DatabaseSyncLike, identity: string): void {
  setMeta(db, EMBEDDING_MODEL_META_KEY, identity);
}

function loadStoredEmbeddingModel(on: OnHandle): string | null {
  try {
    return on(storedIndexStateAt).storedModel;
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
    hasVectors: index ? Object.keys(index).length > 0 : on(storedIndexStateAt).hasVectors,
  });
}

export function embeddingModelRequiresReindex(on: OnHandle, model: string, index?: Record<string, number[]>): boolean {
  return indexNeedsRebuild(resolveIndexedEmbeddingModel(on, index), model);
}

/**
 * Every stored vector keyed by memory id; `{}` when none. Search reads only the rows it ranks via `loadStoredVectors`.
 */
export function loadEmbeddingIndexAt(db: DatabaseSyncLike): Record<string, number[]> {
  return Object.fromEntries(loadVectors(db));
}

/** How many vectors are stored and the float count of the first row, with no vector decoded. */
export function storedVectorSummaryAt(db: DatabaseSyncLike): StoredVectorSummary {
  return { vectors: storedVectorCount(db), dims: storedVectorDims(db) };
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

/** Vectors staged by page on a handle of their own, so neither the live index nor the caller holds them all. */
export interface VectorRebuild {
  /** Stages one page, skipping empty or non-finite vectors; answers how many it staged. */
  stage(rows: ReadonlyArray<readonly [string, readonly number[]]>): number;
  /** In one transaction, swaps the staged vectors in and records `model` as what built them. */
  commit(model: string): void;
  close(): void;
}

/** A rebuild staged on `db`, a handle of its own that `release` closes, which drops the staging table with it. */
export function beginVectorRebuildAt(db: DatabaseSyncLike, release: () => void): VectorRebuild {
  openVectorStaging(db);
  return {
    stage: (rows) => stageVectors(db, rows),
    commit: (model) =>
      withWriteScope(db, 'rebuild_vectors', () => {
        replaceVectorsWithStaged(db, model);
        saveIndexIdentityAt(db, model);
      }),
    close: release,
  };
}

/** How many memories and vectors hippo.db holds, and how many memories have a vector. */
export function vectorCoverageAt(db: DatabaseSyncLike): VectorCoverage {
  return { memories: countAllEntriesAt(db), ...countVectors(db) };
}

/** Drops the vectors of deleted memories. */
export function pruneOrphanVectorsAt(db: DatabaseSyncLike): void {
  deleteOrphanVectors(db);
}

/** The ids with no vector, in id order, `page.limit` at a time after `page.afterId`: a backfill needs each once. */
export function pendingVectorIdsAt(db: DatabaseSyncLike, page: IdPageRequest): IdPage {
  const after = afterIdAnd(page.afterId);
  const rows = cachedStatement(
    db,
    `SELECT id FROM memories
       WHERE NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id = memories.id)${after.sql}
       ORDER BY id LIMIT ?`,
  ).all(...after.args, page.limit + 1) as Array<{ id: string }>;
  return idPageOf(rows, page.limit);
}

export function entriesWithoutVectorAt(db: DatabaseSyncLike, query: VectorBackfillQuery): MemoryEntry[] {
  if (!Number.isInteger(query.limit)) throw new RangeError('limit must be an integer');
  const limit = Math.max(1, Math.min(query.limit, MAX_BACKFILL_PAGE));
  const tenant = tenantAnd(query.tenantId);
  const rows = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id > ?${tenant.sql}
       AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id = memories.id AND v.model = ?)
     ORDER BY id LIMIT ?`,
  ).all(query.afterId ?? '', ...tenant.args, query.model, limit) as MemoryRow[];
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

// savePhysicsState opens its own transaction and overwrites, so the first particle for a memory is inserted here
// instead.
function insertNewParticles(db: DatabaseSyncLike, rows: readonly VectorRowWrite[]): void {
  const stmt = cachedStatement(
    db,
    `INSERT INTO memory_physics (memory_id, position_blob, velocity_blob, mass, charge, temperature, last_simulation)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(memory_id) DO NOTHING`,
  );
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
    const replaces = replacesIndex(storedIndexStateAt(db), write.model);
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
function loadStoredParticlesAt(db: DatabaseSyncLike): PhysicsParticle[] {
  return Array.from(loadPhysicsState(db).values());
}

/** The particle count and mean speed from the velocity column alone, and every particle while at most `fullUpTo` are
 * stored, on one snapshot. */
export function particleStatsAt(db: DatabaseSyncLike, fullUpTo: number): ParticleStats {
  return withReadSnapshot(db, () => {
    const { count, speedSum } = physicsSpeedSum(db);
    const particles = count > 0 && count <= fullUpTo ? loadStoredParticlesAt(db) : null;
    return { count, meanSpeed: count > 0 ? speedSum / count : 0, particles };
  });
}

/** The memory id of every stored particle in loadStoredParticlesAt's order, so a caller reads only the particles it
 * keeps. */
export function storedParticleIdsAt(db: DatabaseSyncLike): string[] {
  const rows = cachedStatement(db, 'SELECT memory_id FROM memory_physics ORDER BY rowid').all() as Array<{
    memory_id: string;
  }>;
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
const RESET_ID_PAGE = 1000;

/** Every memory with a stored vector, paired with it, in id order, since a reset seeds each once; only one page of
 * each is held. */
function* storedSeeds(db: DatabaseSyncLike): Generator<ParticleSeed> {
  let afterId: string | undefined;
  do {
    const page = loadEntryIdsByIdAt(db, { limit: RESET_ID_PAGE, afterId });
    for (const ids of chunked(page.ids, PARTICLE_PAGE)) {
      const vectors = loadVectors(db, ids);
      const rows = selectEntriesByIds(db, [...vectors.keys()], ALL_TENANTS);
      for (const id of ids) {
        const entry = rows.get(id);
        const vector = vectors.get(id);
        if (entry && vector) yield [entry, vector];
      }
    }
    afterId = page.next ?? undefined;
  } while (afterId !== undefined);
}

/** Replaces every particle with a fresh one per memory that has a stored vector; returns how many. */
export function resetStoredParticlesAt(db: DatabaseSyncLike, rules: LossAversion): number {
  return resetPhysicsFromSeeds(db, storedSeeds(db), strengthOptionsOf(rules));
}

/** Stores a first particle for `entry`, placed at `vector`; a memory that has one keeps it. */
export function seedStoredParticleAt(
  db: DatabaseSyncLike,
  rules: LossAversion,
  entry: MemoryEntry,
  vector: number[],
): void {
  if (loadPhysicsState(db, [entry.id]).has(entry.id)) return;
  savePhysicsState(db, [initializeParticle(entry, vector, strengthOptionsOf(rules))]);
}
