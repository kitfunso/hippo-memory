// hippo.db's own vector index: what embedding under its folder lock and the embed and status verbs read and write.
// Vectors and particles carry no tenant, so each method covers the whole store.
import type { MemoryEntry } from '../../core/memory.js';
import type { PhysicsParticle } from '../../core/physics.js';
import type { StoredVectorSummary } from '../vector-index.js';

export interface EmbeddingIndex {
  /** Whether another model than `providerId` built the stored vectors; an unreadable index answers false. */
  requiresReindex(providerId: string): boolean;
  /** Records `providerId`'s index identity as what built the vectors. */
  saveModel(providerId: string): void;
  entryCount(): number;
  /** Every memory id, by created then id. */
  entryIds(): string[];
  /** The rows of `ids` that exist, in no set order. */
  entriesByIds(ids: readonly string[]): MemoryEntry[];
  /** Every stored vector by memory id, orphans included. */
  vectors(): Record<string, number[]>;
  summary(): StoredVectorSummary;
  particles(): PhysicsParticle[];
  /** Upserts each row under `model`, one commit per row so a failure keeps those before it; answers how many. */
  saveVectors(rows: Iterable<readonly [string, readonly number[]]>, model: string): number;
  /** Replaces every stored vector with `index`, under `model` or else the stored identity. */
  replaceVectors(index: Record<string, number[]>, model?: string): void;
  /** Drops the vectors of deleted memories, then answers the ids with no vector, by created then id. */
  pruneListPending(): string[];
  /** Replaces every particle with a fresh one per memory in `ids` that `index` holds a vector for; answers how many. */
  resetParticles(ids: readonly string[], index: Record<string, number[]>): number;
  /** A first particle for `entry` at `vector`, unless it has one. */
  seedParticle(entry: MemoryEntry, vector: number[]): void;
}
