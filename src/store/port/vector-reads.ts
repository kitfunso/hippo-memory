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
