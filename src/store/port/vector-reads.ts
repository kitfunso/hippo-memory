import type { MemoryEntry } from '../../core/memory.js';
import type { PhysicsParticle } from '../../core/physics.js';
import type { OriginFilter } from './types.js';

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

/** What a store's vector index was built by: the stored identity, and whether any vector exists. */
export interface EmbeddingIndexState {
  readonly storedModel: string | null;
  readonly hasVectors: boolean;
}

/** Which rows the vector arm of hybrid search may add: the same tenant, scope and superseded rules as the lexical
 * load. */
export interface VectorCandidateSpec {
  tenantId?: string;
  scope?: RecallScopeFilter;
  includeSuperseded: boolean;
  /** How many nearest rows to add; default 50. */
  limit?: number;
  origin?: OriginFilter;
}

/** Recall scope filter: 'default-deny' (exclude RECALL_DEFAULT_DENY_SCOPES), 'exact' (m.scope = value),
 * 'default-deny-or-exact' (both; CLI `--scope`). @internal Internal SQL-builder shape; not re-exported from
 * `src/index.ts`. Subject to change. */
export type RecallScopeFilter =
  | { mode: 'default-deny'; ownScope?: string }
  | { mode: 'exact'; value: string }
  | { mode: 'default-deny-or-exact'; value: string; ownScope?: string };
