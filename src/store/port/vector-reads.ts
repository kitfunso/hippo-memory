import type { EmbeddingIndexState } from '../vector-index.js';
import type { VectorCandidateSpec } from '../search-rows.js';
import type { MemoryEntry } from '../../core/memory.js';
import type { PhysicsParticle } from '../../core/physics.js';

/** The reads behind recall's vector arm. */
export interface VectorReads {
  /** The stored model and whether any vector exists, in one snapshot. */
  embeddingIndexState(): Promise<EmbeddingIndexState>;
  storedVectors(ids: readonly string[]): Promise<Map<string, number[]>>;
  /** The `spec.limit ?? 50` rows nearest `queryVector` by `rankVectorRows`, filtered by tenant (when set), kind !=
   * 'archived', superseded only with `includeSuperseded`, scope per `RecallScopeFilter`, and origin '' or listed (when
   * `spec.origin` is set). */
  nearestEntries(queryVector: readonly number[], spec: VectorCandidateSpec): Promise<MemoryEntry[]>;
  /** The particles of `ids` only; an empty list reads nothing. */
  physicsParticles(ids: readonly string[]): Promise<Map<string, PhysicsParticle>>;
}
