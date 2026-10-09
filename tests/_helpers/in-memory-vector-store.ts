// A store other than hippo.db for recall's vector reads: it copies hippo.db's vectors, particles and filter columns into memory once,
// then answers with the pieces hippo-memory/server exports, so a parity test shows those pieces are all another store needs.
import { closeHippoDb, getMeta, openHippoDb } from '../../src/db/index.js';
import { passesScopeFilterForRecall } from '../../src/store/recall-scope.js';
import {
  bufferToFloat32, decodeVector, EMBEDDING_MODEL_META_KEY, rankVectorRows,
  type HippoStore, type PhysicsParticle, type RecallScopeFilter, type VectorCandidateSpec, type VectorReads, type VectorRow,
} from '../../src/server.js';
import { portOnlyStore } from './port-only-store.js';

export interface FilterRow {
  readonly tenant_id: string;
  readonly kind: string;
  readonly scope: string | null;
  readonly superseded_by: string | null;
  readonly origin_project: string | null;
}

interface PhysicsRow {
  readonly memory_id: string;
  readonly position_blob: Uint8Array;
  readonly velocity_blob: Uint8Array;
  readonly mass: number;
  readonly charge: number;
  readonly temperature: number;
  readonly last_simulation: string;
}

function passesScope(scope: string | null, filter: RecallScopeFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.mode === 'exact') return scope === filter.value;
  const admitted = passesScopeFilterForRecall(scope, undefined, filter.ownScope);
  return filter.mode === 'default-deny' ? admitted : admitted || scope === filter.value;
}

// The JS twin of loadVectorCandidateEntries' WHERE: a NULL origin_project fails both arms there, so it fails here too.
export function passesSpec(row: FilterRow, spec: VectorCandidateSpec): boolean {
  if (spec.tenantId !== undefined && row.tenant_id !== spec.tenantId) return false;
  if (row.kind === 'archived' || (!spec.includeSuperseded && row.superseded_by !== null)) return false;
  const origins: readonly string[] | undefined = spec.origin === undefined ? undefined : [spec.origin].flat();
  if (origins !== undefined && row.origin_project !== '' && !origins.some((o) => o === row.origin_project)) return false;
  return passesScope(row.scope, spec.scope);
}

export interface InMemoryVectorStore {
  readonly store: HippoStore & { readonly vectors: VectorReads };
  /** Each vector read's name, in call order. */
  readonly calls: string[];
}

/** Rows go to the ranker in descending id order, the opposite of the tie-break, so only rankVectorRows can make a tie agree with hippo.db. */
export function inMemoryVectorStore(hippoRoot: string): InMemoryVectorStore {
  const db = openHippoDb(hippoRoot);
  let storedModel: string | null;
  let vectorRows: { id: string; vector: Uint8Array }[];
  let filterRows: (FilterRow & { id: string })[];
  let physicsRows: PhysicsRow[];
  try {
    storedModel = getMeta(db, EMBEDDING_MODEL_META_KEY, '').trim() || null;
    // SAFETY: each SELECT names exactly the columns of the row type it is read as; node:sqlite returns BLOBs as Uint8Array.
    vectorRows = db.prepare('SELECT memory_id AS id, vector FROM memory_vectors ORDER BY memory_id DESC').all() as typeof vectorRows;
    // SAFETY: as above.
    filterRows = db.prepare('SELECT id, tenant_id, kind, scope, superseded_by, origin_project FROM memories').all() as typeof filterRows;
    // SAFETY: as above.
    physicsRows = db.prepare('SELECT memory_id, position_blob, velocity_blob, mass, charge, temperature, last_simulation FROM memory_physics').all() as PhysicsRow[];
  } finally {
    closeHippoDb(db);
  }
  const vectors: VectorRow[] = vectorRows.map((r) => ({ id: r.id, vector: decodeVector(r.vector) }));
  const vectorById = new Map(vectors.map((r) => [r.id, r.vector]));
  const filters = new Map(filterRows.map((r) => [r.id, r]));
  const particles = new Map(physicsRows.map((r): [string, PhysicsParticle] => [r.memory_id, {
    memoryId: r.memory_id,
    position: bufferToFloat32(r.position_blob),
    velocity: bufferToFloat32(r.velocity_blob),
    mass: r.mass,
    charge: r.charge,
    temperature: r.temperature,
    lastSimulation: r.last_simulation,
  }]));
  const port = portOnlyStore(hippoRoot);
  const calls: string[] = [];
  const store: InMemoryVectorStore['store'] = {
    ...port,
    kind: 'in-memory',
    vectors: {
      async embeddingIndexState() {
        calls.push('embeddingIndexState');
        return { storedModel, hasVectors: vectors.length > 0 };
      },
      async storedVectors(ids) {
        calls.push('storedVectors');
        return new Map(ids.flatMap((id): [string, number[]][] => {
          const v = vectorById.get(id);
          return v ? [[id, Array.from(v)]] : [];
        }));
      },
      async nearestEntries(queryVector, spec) {
        calls.push('nearestEntries');
        const admitted = vectors.filter((r) => {
          const row = filters.get(r.id);
          return row !== undefined && passesSpec(row, spec);
        });
        const matches = rankVectorRows(queryVector, admitted, spec.limit ?? 50);
        const rows = new Map((await port.entriesByIds(matches.map((m) => m.id), spec.tenantId)).map((e) => [e.id, e]));
        return matches.flatMap((m) => rows.get(m.id) ?? []);
      },
      async physicsParticles(ids) {
        calls.push('physicsParticles');
        return new Map(ids.flatMap((id): [string, PhysicsParticle][] => {
          const p = particles.get(id);
          return p ? [[id, p]] : [];
        }));
      },
    },
  };
  return { store, calls };
}
