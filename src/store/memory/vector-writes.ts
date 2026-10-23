// The in-memory VectorWrites group: the backfill read and the vector write, keeping the stored vector bytes.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { PhysicsParticle } from '../../base/rank/physics.js';
import { replacesIndex } from '../../base/embeddings/index-identity.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { bufferToFloat32, float32ToBuffer } from '../../base/util/vector-codec.js';
import { EMBEDDING_MODEL_META_KEY, encodeVector } from '../../db/vector-store.js';
import type { VectorBackfillQuery, VectorWrite, VectorWriteResult, VectorWrites } from '../port/vectors.js';
import { byBytes } from '../rules/order.js';
import type { MemoryTables } from './tables.js';
import { indexState } from './vectors.js';

// Positions and velocities are stored as Float32, so a particle reads back rounded the same under either store.
function storedParticle(p: PhysicsParticle, memoryId: string): PhysicsParticle {
  const position = bufferToFloat32(float32ToBuffer(p.position));
  return { ...p, memoryId, position, velocity: bufferToFloat32(float32ToBuffer(p.velocity)) };
}

function withoutVectorIn(
  t: MemoryTables,
  { model, afterId = '', limit, tenantId }: VectorBackfillQuery,
): MemoryEntry[] {
  if (!Number.isInteger(limit)) throw new RangeError('limit must be an integer');
  const ids = [...t.entries.keys()]
    .sort(byBytes)
    .filter(
      (id) =>
        byBytes(id, afterId) > 0 &&
        t.vectors.get(id)?.model !== model &&
        (tenantId === ALL_TENANTS || t.entries.get(id)?.tenantId === tenantId),
    );
  return ids.slice(0, Math.max(1, Math.min(limit, 500))).flatMap((id) => {
    const entry = t.entries.get(id);
    return entry ? [structuredClone(entry)] : [];
  });
}

function writeIn(t: MemoryTables, { tenantId, model, replaceIndex, rows }: VectorWrite): VectorWriteResult {
  const replaces = replacesIndex(indexState(t), model);
  if (replaces && !replaceIndex) return { written: 0, modelMismatch: true };
  const writable = rows.filter(
    (r) => t.entries.get(r.memoryId)?.tenantId === tenantId && r.vector.length > 0 && r.vector.every(Number.isFinite),
  );
  if (writable.length === 0) return { written: 0, modelMismatch: false };
  if (replaces) {
    t.vectors.clear();
    t.particles.clear();
  }
  for (const r of writable) t.vectors.set(r.memoryId, { model, bytes: encodeVector(r.vector) });
  for (const r of writable) {
    if (r.particle && !t.particles.has(r.memoryId)) t.particles.set(r.memoryId, storedParticle(r.particle, r.memoryId));
  }
  t.meta.set(EMBEDDING_MODEL_META_KEY, model);
  return { written: writable.length, modelMismatch: false };
}

export function memoryVectorWrites(t: MemoryTables): VectorWrites {
  return {
    entriesWithoutVector: async (query) => withoutVectorIn(t, query),
    writeVectors: async (write) => writeIn(t, write),
  };
}
