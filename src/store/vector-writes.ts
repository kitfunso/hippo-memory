// hippo.db's half of the VectorWrites store group.
import { closeHippoDb, openHippoDb, setMeta, withWriteScope, type DatabaseSyncLike } from '../db.js';
import { embeddingIndexStateOn, replacesIndex } from '../embeddings.js';
import type { MemoryEntry } from '../memory.js';
import type { PhysicsParticle } from '../physics.js';
import { float32ToBuffer, loadPhysicsState, resetAllPhysicsState } from '../db/physics-state.js';
import type { VectorBackfillQuery, VectorRowWrite, VectorWrite, VectorWriteResult } from './port.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../db/vector-store.js';
import { chunked } from './entry-reads.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from './rows.js';

const MAX_BACKFILL_PAGE = 500;

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
    const rows = db.prepare(`SELECT id FROM memories WHERE +tenant_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`).all(tenantId, ...chunk) as { id: string }[];
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
  const db = openHippoDb(hippoRoot);
  try {
    return Array.from(loadPhysicsState(db).values());
  } finally {
    closeHippoDb(db);
  }
}

/** Replaces every particle under `hippoRoot` with a fresh one per entry that has an embedding; returns how many. */
export function resetStoredParticles(hippoRoot: string, entries: MemoryEntry[], embeddingIndex: Record<string, number[]>): number {
  const db = openHippoDb(hippoRoot);
  try {
    return resetAllPhysicsState(db, entries, embeddingIndex);
  } finally {
    closeHippoDb(db);
  }
}
