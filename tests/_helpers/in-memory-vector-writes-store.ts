// A store other than hippo.db for the VectorWrites group: it copies memories, vectors, particles and the model meta row out of hippo.db once,
// then reads and writes them in memory with what hippo-memory/server exports, so a conformance test shows that is all another store needs.
import { listAuditEventsAfter } from '../../src/audit.js';
import { closeHippoDb, getMeta, openHippoDb } from '../../src/db.js';
import { loadPhysicsState } from '../../src/db/physics-state.js';
import {
  bufferToFloat32, decodeVector, EMBEDDING_MODEL_META_KEY, encodeVector, float32ToBuffer, rankVectorRows, replacesIndex,
  type AuditEvent, type EmbeddingIndexState, type HippoStore, type MemoryEntry, type PhysicsParticle, type VectorReads, type VectorWrites,
} from '../../src/server.js';
import { selectAllEntries } from '../../src/store/entry-reads.js';
import { passesSpec, type FilterRow } from './in-memory-vector-store.js';
import { portOnlyStoreWithoutVectorReads } from './port-only-store.js';
import type { StoreSide } from './store-conformance.js';

export interface InMemoryVectorWritesStore extends StoreSide {
  readonly store: HippoStore & { readonly vectors: VectorReads; readonly vectorWrites: VectorWrites };
}

interface StoredVector {
  readonly model: string;
  readonly bytes: Uint8Array;
}

interface Copied {
  readonly entries: Map<string, MemoryEntry>;
  readonly filters: Map<string, FilterRow>;
  readonly vectors: Map<string, StoredVector>;
  readonly particles: Map<string, PhysicsParticle>;
  readonly storedModel: string;
  readonly audit: AuditEvent[];
}

function copyRows(hippoRoot: string): Copied {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: each SELECT names exactly the columns of the row type it is read as; node:sqlite returns BLOBs as Uint8Array.
    const vectorRows = db.prepare('SELECT memory_id, model, vector FROM memory_vectors').all() as { memory_id: string; model: string; vector: Uint8Array }[];
    // SAFETY: as above.
    const filterRows = db.prepare('SELECT id, tenant_id, kind, scope, superseded_by, origin_project FROM memories').all() as (FilterRow & { id: string })[];
    return {
      entries: new Map(selectAllEntries(db).map((e) => [e.id, e])),
      filters: new Map(filterRows.map((r) => [r.id, r])),
      vectors: new Map(vectorRows.map((r) => [r.memory_id, { model: r.model, bytes: new Uint8Array(r.vector) }])),
      particles: loadPhysicsState(db),
      storedModel: getMeta(db, EMBEDDING_MODEL_META_KEY, ''),
      audit: listAuditEventsAfter(db, { afterId: 0, limit: 10_000 }),
    };
  } finally {
    closeHippoDb(db);
  }
}

// hippo.db keeps positions and velocities as Float32 BLOBs, so a particle read back is rounded the same way.
function asStored(p: PhysicsParticle, memoryId: string): PhysicsParticle {
  return { ...p, memoryId, position: bufferToFloat32(float32ToBuffer(p.position)), velocity: bufferToFloat32(float32ToBuffer(p.velocity)) };
}

export function inMemoryVectorWritesStore(hippoRoot: string): InMemoryVectorWritesStore {
  const { entries, filters, vectors, particles, audit, ...meta } = copyRows(hippoRoot);
  let { storedModel } = meta;
  const indexState = (): EmbeddingIndexState => ({ storedModel: storedModel.trim() || null, hasVectors: vectors.size > 0 });
  const vectorReads: VectorReads = {
    async embeddingIndexState() {
      return indexState();
    },
    async storedVectors(ids) {
      return new Map(ids.flatMap((id): [string, number[]][] => {
        const v = vectors.get(id);
        return v ? [[id, Array.from(decodeVector(v.bytes))]] : [];
      }));
    },
    async nearestEntries(queryVector, spec) {
      const admitted = [...vectors].flatMap(([id, v]) => {
        const row = filters.get(id);
        return row !== undefined && passesSpec(row, spec) ? [{ id, vector: decodeVector(v.bytes) }] : [];
      });
      return rankVectorRows(queryVector, admitted, spec.limit ?? 50).flatMap((m) => {
        const entry = entries.get(m.id);
        return entry ? [structuredClone(entry)] : [];
      });
    },
    async physicsParticles(ids) {
      return new Map(ids.flatMap((id): [string, PhysicsParticle][] => {
        const p = particles.get(id);
        return p ? [[id, structuredClone(p)]] : [];
      }));
    },
  };
  const vectorWrites: VectorWrites = {
    async entriesWithoutVector({ model, afterId = '', limit, tenantId }) {
      if (!Number.isInteger(limit)) throw new RangeError('limit must be an integer');
      const ids = [...entries.keys()].sort().filter((id) => id > afterId && vectors.get(id)?.model !== model
        && (tenantId === undefined || entries.get(id)?.tenantId === tenantId));
      return ids.slice(0, Math.max(1, Math.min(limit, 500))).flatMap((id) => {
        const entry = entries.get(id);
        return entry ? [structuredClone(entry)] : [];
      });
    },
    async writeVectors({ tenantId, model, replaceIndex, rows }) {
      const replaces = replacesIndex(indexState(), model);
      if (replaces && !replaceIndex) return { written: 0, modelMismatch: true };
      const writable = rows.filter((r) => entries.get(r.memoryId)?.tenantId === tenantId && r.vector.length > 0 && r.vector.every(Number.isFinite));
      if (writable.length === 0) return { written: 0, modelMismatch: false };
      if (replaces) {
        vectors.clear();
        particles.clear();
      }
      for (const r of writable) vectors.set(r.memoryId, { model, bytes: encodeVector(r.vector) });
      for (const r of writable) if (r.particle && !particles.has(r.memoryId)) particles.set(r.memoryId, asStored(r.particle, r.memoryId));
      storedModel = model;
      return { written: writable.length, modelMismatch: false };
    },
  };
  const store: InMemoryVectorWritesStore['store'] = {
    ...portOnlyStoreWithoutVectorReads(hippoRoot),
    kind: 'in-memory',
    vectors: vectorReads,
    vectorWrites,
  };
  return { store, auditRows: () => structuredClone(audit) };
}
