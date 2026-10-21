// The in-memory VectorReads group: hippo.db's vector bytes and particles, ranked with hippo.db's own code.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { PhysicsParticle } from '../../base/rank/physics.js';
import { passesScopeFilterForRecall, type RecallScopeFilter } from '../../base/scope/recall-scope.js';
import type { EmbeddingIndexState } from '../../base/embeddings/index-identity.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { decodeVector, EMBEDDING_MODEL_META_KEY, rankVectorRows } from '../../db/vector-store.js';
import type { VectorCandidateSpec, VectorReads } from '../port/vector-reads.js';
import type { MemoryTables } from './tables.js';

function passesScope(scope: string | null, filter: RecallScopeFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.mode === 'exact') return scope === filter.value;
  const admitted = passesScopeFilterForRecall(scope, undefined, filter.ownScope);
  return filter.mode === 'default-deny' ? admitted : admitted || scope === filter.value;
}

// The twin of the candidate reads' WHERE: a null origin fails both arms there, so it fails here too.
export function admitsCandidate(row: MemoryEntry, spec: VectorCandidateSpec): boolean {
  if (spec.tenantId !== ALL_TENANTS && row.tenantId !== spec.tenantId) return false;
  if (row.kind === 'archived' || (!spec.includeSuperseded && row.supersededBy !== null)) return false;
  const origins: readonly string[] | undefined = spec.origin === undefined ? undefined : [spec.origin].flat();
  const origin = row.originProject ?? null;
  if (origins !== undefined && origin !== '' && !origins.some((o) => o === origin)) return false;
  return passesScope(row.scope, spec.scope);
}

export function indexState(t: MemoryTables): EmbeddingIndexState {
  return { storedModel: (t.meta.get(EMBEDDING_MODEL_META_KEY) ?? '').trim() || null, hasVectors: t.vectors.size > 0 };
}

/** Drops the vectors and particles of memories no longer held, as hippo.db's delete trigger and cascade do. */
export function dropOrphanVectors(t: MemoryTables): void {
  for (const id of t.vectors.keys()) if (!t.entries.has(id)) t.vectors.delete(id);
  for (const id of t.particles.keys()) if (!t.entries.has(id)) t.particles.delete(id);
}

function nearestIn(t: MemoryTables, queryVector: readonly number[], spec: VectorCandidateSpec): MemoryEntry[] {
  const admitted = [...t.vectors].flatMap(([id, v]) => {
    const row = t.entries.get(id);
    return row !== undefined && admitsCandidate(row, spec) ? [{ id, vector: decodeVector(v.bytes) }] : [];
  });
  return rankVectorRows(queryVector, admitted, spec.limit ?? 50).flatMap((m) => {
    const entry = t.entries.get(m.id);
    return entry ? [structuredClone(entry)] : [];
  });
}

export function memoryVectors(t: MemoryTables): VectorReads {
  return {
    embeddingIndexState: async () => indexState(t),
    async storedVectors(ids) {
      const found = ids.flatMap((id): [string, number[]][] => {
        const v = t.vectors.get(id);
        return v ? [[id, Array.from(decodeVector(v.bytes))]] : [];
      });
      return new Map(found);
    },
    nearestEntries: async (queryVector, spec) => nearestIn(t, queryVector, spec),
    async physicsParticles(ids) {
      const found = ids.flatMap((id): [string, PhysicsParticle][] => {
        const p = t.particles.get(id);
        return p ? [[id, structuredClone(p)]] : [];
      });
      return new Map(found);
    },
  };
}
