// The vector groups: recall's vector arm, the stored vectors and particles, their writes and a store's own index.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { PhysicsParticle } from '../../base/rank/physics.js';
import type { RecallScopeFilter } from '../../base/scope/recall-scope.js';
import type { EmbeddingIndexState } from '../../base/embeddings/index-identity.js';
import type { OriginFilter } from './types.js';
import type { TenantId } from '../../base/util/tenant.js';

export type { EmbeddingIndexState, RecallScopeFilter };

/** The reads behind recall's vector arm. */
export interface VectorReads {
  /** The stored model and whether any vector exists, in one snapshot. */
  embeddingIndexState(): Promise<EmbeddingIndexState>;
  storedVectors(ids: readonly string[]): Promise<Map<string, number[]>>;
  /** The `spec.limit ?? VECTOR_CANDIDATE_LIMIT` rows nearest `queryVector` by `rankVectorRows`, filtered by tenant
   * (when set), kind != 'archived', superseded only with `includeSuperseded`, scope per `RecallScopeFilter`, and origin
   * '' or listed (when `spec.origin` is set). */
  nearestEntries(queryVector: readonly number[], spec: VectorCandidateSpec): Promise<MemoryEntry[]>;
  /** The particles of `ids` only; an empty list reads nothing. */
  physicsParticles(ids: readonly string[]): Promise<Map<string, PhysicsParticle>>;
}

/** Asks another process for the ids nearest a query, nearest first; undefined leaves the read to this store's scan. */
export type NearestIdsAsk = (
  queryVector: readonly number[],
  spec: VectorCandidateSpec,
) => Promise<readonly string[] | undefined>;

/** How many nearest rows the vector arm adds when its spec sets no `limit`. */
export const VECTOR_CANDIDATE_LIMIT = 50;

/**
 * Which rows the vector arm of hybrid search may add: the same tenant, scope and superseded rules as the lexical load.
 */
export interface VectorCandidateSpec {
  tenantId: TenantId;
  scope?: RecallScopeFilter;
  includeSuperseded: boolean;
  /** How many nearest rows to add; VECTOR_CANDIDATE_LIMIT when unset. */
  limit?: number;
  origin?: OriginFilter;
}

/** `storedVectors` with no number[] copy, for a store that holds vectors as Float32 bytes. */
export interface VectorViews {
  /** The same ids and values as `VectorReads.storedVectors`, each value a Float32 view. */
  storedVectorViews(ids: readonly string[]): Promise<Map<string, Float32Array>>;
}

/** One memory's vector, computed by the caller's embedding provider. */
export interface VectorRowWrite {
  readonly memoryId: string;
  readonly vector: readonly number[];
  /** Kept only when the memory has no particle yet, under `memoryId` whatever its own memoryId says. */
  readonly particle?: PhysicsParticle;
}

export interface VectorWrite {
  readonly tenantId: string;
  /** The index identity the vectors were built by, `embeddingIndexIdentity(provider.id)`. */
  readonly model: string;
  /** Set only by embedAll's rebuild, so a write that read the index state before another process rebuilt it cannot drop
   * that rebuild. */
  readonly replaceIndex: boolean;
  readonly rows: readonly VectorRowWrite[];
}

export interface VectorWriteResult {
  readonly written: number;
  /** True when another model built the index and `replaceIndex` is false; the store then keeps nothing and `written` is
   * 0. */
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

/** The writes behind embed on write and the backfill: core computes each vector, the store only keeps it. A store
 * deletes a memory's vector and particle when the memory is deleted (hippo.db does it itself). */
export interface VectorWrites {
  /** Memories of any kind with no vector stored under `query.model`, by id ascending in byte order. */
  entriesWithoutVector(query: VectorBackfillQuery): Promise<MemoryEntry[]>;
  /** In one transaction: refuses with `modelMismatch` if `replacesIndex` and not `replaceIndex`; else drops every
   * vector and particle if `replacesIndex`, keeps each writable row (memory in `tenantId`, finite non-empty vector)
   * under `model` with its particle, sets `model`. No audit row. */
  writeVectors(write: VectorWrite): Promise<VectorWriteResult>;
}

// A store's own vector index, which the embed and status verbs read and write. Vectors and particles carry no tenant,
// so each method covers the whole store.
export interface EmbeddingIndex {
  /** Whether another model than `providerId` built the stored vectors; an unreadable index answers false. */
  requiresReindex(providerId: string): Promise<boolean>;
  /** Records `providerId`'s index identity as what built the vectors. */
  saveModel(providerId: string): Promise<void>;
  entryCount(): Promise<number>;
  /** Up to `page.limit` memory ids in id order after `page.afterId`: a re-embed needs each row once, not time order. */
  entryIdsPage(page: IdPageRequest): Promise<IdPage>;
  /** The rows of `ids` that exist, in no set order. */
  entriesByIds(ids: readonly string[]): Promise<MemoryEntry[]>;
  summary(): Promise<StoredVectorSummary>;
  /** How many memories and vectors the store holds, and how many memories have a vector. */
  coverage(): Promise<VectorCoverage>;
  /** The particle count and mean speed, and every particle only while at most `fullUpTo` are stored. */
  particleStats(fullUpTo: number): Promise<ParticleStats>;
  /** Upserts each row under `model`, one commit per row so a failure keeps those before it; answers how many. */
  saveVectors(rows: readonly VectorRow[], model: string): Promise<number>;
  /** Opens a rebuild whose vectors wait apart from the live index; the id names it to the three calls below. */
  beginRebuild(): Promise<string>;
  /** Stages one page of vectors, skipping empty or non-finite ones; answers how many it staged. */
  stageRebuild(rebuild: string, rows: readonly VectorRow[]): Promise<number>;
  /** In one transaction, replaces every stored vector with the staged ones and records `model` as what built them. */
  commitRebuild(rebuild: string, model: string): Promise<void>;
  /** Drops what is staged; a rebuild never committed leaves the live index as it was. */
  closeRebuild(rebuild: string): Promise<void>;
  /** Drops the vectors of deleted memories. */
  pruneOrphans(): Promise<void>;
  /** Up to `page.limit` ids with no vector, in id order after `page.afterId`. */
  pendingIds(page: IdPageRequest): Promise<IdPage>;
  /** Replaces every particle with a fresh one per memory that has a stored vector, reading a page at a time; answers
   * how many. */
  resetParticles(): Promise<number>;
  /** A first particle for `entry` at `vector`, unless it has one. */
  seedParticle(entry: MemoryEntry, vector: number[]): Promise<void>;
  /** Names the store's hippo.db, so writers to one file in this process wait on each other and writers to another do
   * not. */
  lockKey(): Promise<string>;
  /** Takes the index's write lock, which other processes on the store honour; a token to unlock, or null while a live
   * holder has it. */
  tryLock(): Promise<string | null>;
  /** Releases the lock `token` took; a lock another holder took since is left. */
  unlock(token: string): Promise<void>;
}

/** One memory's vector. */
export type VectorRow = readonly [memoryId: string, vector: readonly number[]];

/** `particles` is null past the caller's limit, so a large store is summed a column at a time, never loaded. */
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

/** A page of memory ids in id order, and the id the next page starts after; null on the last page. */
export interface IdPage {
  readonly ids: string[];
  readonly next: string | null;
}

export interface VectorCoverage {
  readonly memories: number;
  readonly vectors: number;
  /** Memories with a vector; the other vectors are orphans of deleted memories. */
  readonly embedded: number;
}

export interface StoredVectorSummary {
  /** Stored vectors, orphans of deleted memories included. */
  readonly vectors: number;
  readonly dims: number | undefined;
}
