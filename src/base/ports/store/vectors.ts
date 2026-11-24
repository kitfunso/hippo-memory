import type { MemoryEntry } from '../../memory/entry.js';
import type { PhysicsParticle } from '../../rank/physics.js';
import type { RecallScopeFilter } from '../../scope/recall-scope.js';
import type { EmbeddingIndexState } from '../../embeddings/index-identity.js';
import type { OriginFilter } from './types.js';
import type { TenantId } from '../../util/tenant.js';
import type { MethodEffects } from './effects.js';

export type { EmbeddingIndexState, RecallScopeFilter };

/** The reads behind recall's vector arm. */
export interface VectorReads {
  /** The stored model and whether any vector exists, in one snapshot. */
  embeddingIndexState(): Promise<EmbeddingIndexState>;
  /** The stored `part` of each of `ids` that has one; an empty list reads nothing. */
  stored<P extends StoredPart>(
    part: P,
    ids: readonly string[],
  ): Promise<Map<string, StoredParts[P]>>;
  /** The `spec.limit ?? VECTOR_CANDIDATE_LIMIT` rows nearest `queryVector` by `rankVectorRows`,
   * filtered by tenant (when set), kind != 'archived', superseded only with `includeSuperseded`,
   * scope per `RecallScopeFilter`, and origin '' or listed (when `spec.origin` is set). */
  nearestEntries(queryVector: readonly number[], spec: VectorCandidateSpec): Promise<MemoryEntry[]>;
}

/** What each VectorReads method does to the store; every adapter honours it. */
export const VECTORS_EFFECTS = {
  embeddingIndexState: 'read',
  stored: 'read',
  nearestEntries: 'read',
} as const satisfies MethodEffects<VectorReads>;

/** What `VectorReads.stored` reads per memory: its vector, as Float32 views where the store
 * holds Float32 bytes, or its particle. */
export interface StoredParts {
  readonly vectors: ArrayLike<number>;
  readonly particles: PhysicsParticle;
}

export type StoredPart = keyof StoredParts;

/** Asks another process for the ids nearest a query, nearest first; undefined leaves the read to
 * this store's scan. */
export type NearestIdsAsk = (
  queryVector: readonly number[],
  spec: VectorCandidateSpec,
) => Promise<readonly string[] | undefined>;

/** How many nearest rows the vector arm adds when its spec sets no `limit`. */
export const VECTOR_CANDIDATE_LIMIT = 50;

/**
 * Which rows the vector arm of hybrid search may add: the same tenant, scope and superseded rules
 * as the lexical load.
 */
export interface VectorCandidateSpec {
  tenantId: TenantId;
  scope?: RecallScopeFilter;
  includeSuperseded: boolean;
  /** How many nearest rows to add; VECTOR_CANDIDATE_LIMIT when unset. */
  limit?: number;
  origin?: OriginFilter;
}

/** One memory's vector, computed by the caller's embedding provider. */
export interface VectorRowWrite {
  readonly memoryId: string;
  readonly vector: readonly number[];
  /** Kept only when the memory has no particle yet, under `memoryId` whatever its own memoryId
   * says. */
  readonly particle?: PhysicsParticle;
}

export interface VectorWrite {
  readonly tenantId: string;
  /** The index identity the vectors were built by, `embeddingIndexIdentity(provider.id)`. */
  readonly model: string;
  /** Set only by embedAll's rebuild, so a write that read the index state before another process
   * rebuilt it cannot drop that rebuild. */
  readonly replaceIndex: boolean;
  readonly rows: readonly VectorRowWrite[];
}

export interface VectorWriteResult {
  readonly written: number;
  /** True when another model built the index and `replaceIndex` is false; the store then keeps
   * nothing and `written` is 0. */
  readonly modelMismatch: boolean;
}

export interface VectorBackfillQuery {
  readonly model: string;
  /** Only ids above this one in byte order; unset starts at the first. */
  readonly afterId?: string;
  /** Clamped to 1..500; a non-integer rejects with RangeError `limit must be an integer`. */
  readonly limit: number;
  /** ALL_TENANTS for the backfill, which covers the whole store. */
  readonly tenantId: TenantId;
}

/** The writes behind embed on write and the backfill: core computes each vector, the store only
 * keeps it. A store deletes a memory's vector and particle when the memory is deleted (hippo.db
 * does it itself). */
export interface VectorWrites {
  /** Memories of any kind with no vector stored under `query.model`, by id ascending in byte
   * order. */
  entriesWithoutVector(query: VectorBackfillQuery): Promise<MemoryEntry[]>;
  /** In one transaction: refuses with `modelMismatch` if `replacesIndex` and not `replaceIndex`;
   * else drops every vector and particle if `replacesIndex`, keeps each writable row (memory in
   * `tenantId`, finite non-empty vector) under `model` with its particle, sets `model`. No audit
   * row. */
  writeVectors(write: VectorWrite): Promise<VectorWriteResult>;
  /** The index these writes land in: every group that writes one index answers the same key, so
   * embed runs on it take turns whatever object a caller holds. */
  indexKey(): Promise<string>;
}

/** What each VectorWrites method does to the store; every adapter honours it. */
export const VECTOR_WRITES_EFFECTS = {
  entriesWithoutVector: 'read',
  writeVectors: 'write',
  indexKey: 'read',
} as const satisfies MethodEffects<VectorWrites>;

export interface EmbeddingIndex {
  open(): Promise<IndexSession>;
  step<K extends IndexStepKind>(session: string, step: IndexStep<K>): Promise<IndexStepAnswers[K]>;
}

/** What each EmbeddingIndex method does to the store; every adapter honours it. */
export const EMBEDDING_INDEX_EFFECTS = {
  open: 'read',
  step: 'write',
} as const satisfies MethodEffects<EmbeddingIndex>;

/** `id` names the session to `step`; `key` names the store's hippo.db, so sessions on one file
 * in this process take turns and sessions on another do not. */
export interface IndexSession {
  readonly id: string;
  readonly key: string;
}

type NoFields = Record<never, never>;

/** What each step takes beside its kind. */
export interface IndexStepFields {
  readonly lock: NoFields;
  readonly begin: NoFields;
  readonly stage: { readonly rows: readonly VectorRow[] };
  readonly commit: { readonly model: string };
  readonly close: NoFields;
  readonly reindex: { readonly providerId: string };
  readonly saveModel: { readonly providerId: string };
  readonly ids: { readonly page: IdPageRequest };
  readonly pending: { readonly page: IdPageRequest };
  readonly save: { readonly rows: readonly VectorRow[]; readonly model: string };
  readonly prune: NoFields;
  readonly seed: { readonly entry: MemoryEntry; readonly vector: number[] };
  readonly reset: NoFields;
  readonly summary: NoFields;
  readonly coverage: NoFields;
  readonly particles: { readonly fullUpTo: number };
}

export type IndexStepKind = keyof IndexStepFields;

/** One step of kind `K`, plain data so it crosses to a store worker. */
export type IndexStep<K extends IndexStepKind = IndexStepKind> = {
  [P in K]: { readonly kind: P } & IndexStepFields[P];
}[K];

export interface IndexStepAnswers {
  readonly lock: boolean;
  readonly begin: void;
  readonly stage: number;
  readonly commit: void;
  readonly close: void;
  readonly reindex: boolean;
  readonly saveModel: void;
  readonly ids: IdPage;
  readonly pending: IdPage;
  readonly save: number;
  readonly prune: void;
  readonly seed: void;
  readonly reset: number;
  readonly summary: StoredVectorSummary;
  readonly coverage: VectorCoverage;
  readonly particles: ParticleStats;
}

/** One memory's vector. */
export type VectorRow = readonly [memoryId: string, vector: readonly number[]];

/** `particles` is null past the caller's limit, so a large store is summed a column at a time,
 * never loaded. */
export interface ParticleStats {
  count: number;
  meanSpeed: number;
  particles: PhysicsParticle[] | null;
}

/** A page in id order: up to `limit` ids after `afterId`, or from the first id when it is unset. */
export interface IdPageRequest {
  readonly limit: number;
  readonly afterId?: string;
}

/** A page of memory ids in id order, and the id the next page starts after; null on the last
 * page. */
export interface IdPage {
  readonly ids: string[];
  readonly next: string | null;
}

export interface VectorCoverage {
  readonly memories: number;
  readonly vectors: number;
  readonly embedded: number;
}

export interface StoredVectorSummary {
  readonly vectors: number;
  readonly dims: number | undefined;
}
