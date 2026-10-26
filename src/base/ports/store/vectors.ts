// The vector groups: recall's vector arm, the stored vectors and particles, their writes and a
// store's own index.
import type { MemoryEntry } from '../../memory/entry.js';
import type { PhysicsParticle } from '../../rank/physics.js';
import type { RecallScopeFilter } from '../../scope/recall-scope.js';
import type { EmbeddingIndexState } from '../../embeddings/index-identity.js';
import type { OriginFilter } from './types.js';
import type { TenantId } from '../../util/tenant.js';

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
 *
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
}

// A store's own vector index, worked through sessions so the write lock and a rebuild's staged
// vectors stay on the thread that holds one. Vectors and particles carry no tenant, so each step
// covers the whole store.
export interface EmbeddingIndex {
  /** Opens a session that holds nothing yet. */
  open(): Promise<IndexSession>;
  /** Runs one step on the open session `session`; `close` ends it. */
  step<K extends IndexStepKind>(session: string, step: IndexStep<K>): Promise<IndexStepAnswers[K]>;
}

/** `id` names the session to `step`; `key` names the store's hippo.db, so sessions on one file
 * in this process take turns and sessions on another do not. */
export interface IndexSession {
  readonly id: string;
  readonly key: string;
}

type NoFields = Record<never, never>;

/** What each step takes beside its kind. */
export interface IndexStepFields {
  /** Takes the index's write lock until `close`; other processes and threads on the store honour
   * it, and it answers false while a live holder has it. */
  readonly lock: NoFields;
  /** Opens a rebuild whose vectors wait apart from the live index. */
  readonly begin: NoFields;
  /** Stages one page of the rebuild, skipping empty or non-finite vectors; answers how many it
   * staged. */
  readonly stage: { readonly rows: readonly VectorRow[] };
  /** In one transaction, replaces every stored vector with the staged ones and records `model`
   * as what built them, then drops the staging, committed or not. */
  readonly commit: { readonly model: string };
  /** Drops a rebuild not committed, which leaves the live index as it was, releases the lock
   * this session took, and ends the session. */
  readonly close: NoFields;
  /** Whether another model than `providerId` built the stored vectors; an unreadable index
   * answers false. */
  readonly reindex: { readonly providerId: string };
  /** Records `providerId`'s index identity as what built the vectors. */
  readonly saveModel: { readonly providerId: string };
  /** Up to `page.limit` memory ids in id order after `page.afterId`: a re-embed needs each row
   * once, not time order. */
  readonly ids: { readonly page: IdPageRequest };
  /** `ids` for the memories with no vector only. */
  readonly pending: { readonly page: IdPageRequest };
  /** Upserts each row under `model`, one commit per row so a failure keeps those before it;
   * answers how many. */
  readonly save: { readonly rows: readonly VectorRow[]; readonly model: string };
  /** Drops the vectors of deleted memories. */
  readonly prune: NoFields;
  /** A first particle for `entry` at `vector`, unless it has one. */
  readonly seed: { readonly entry: MemoryEntry; readonly vector: number[] };
  /** Replaces every particle with a fresh one per memory that has a stored vector, reading a
   * page at a time; answers how many. */
  readonly reset: NoFields;
  readonly summary: NoFields;
  /** How many memories and vectors the store holds, and how many memories have a vector. */
  readonly coverage: NoFields;
  /** The particle count and mean speed, and every particle only while at most `fullUpTo` are
   * stored. */
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
  /** Memories with a vector; the other vectors are orphans of deleted memories. */
  readonly embedded: number;
}

export interface StoredVectorSummary {
  /** Stored vectors, orphans of deleted memories included. */
  readonly vectors: number;
  readonly dims: number | undefined;
}
