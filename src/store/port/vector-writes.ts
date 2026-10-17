import type { PhysicsParticle } from '../../core/physics.js';
import type { MemoryEntry } from '../../core/memory.js';

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
  /** Set only by embedAll's rebuild, so a write that read the index
   * state before another process rebuilt it cannot drop that rebuild. */
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
  /** Every tenant when unset, since the backfill covers the whole store. */
  readonly tenantId?: string;
}

/** The writes behind embed on write and the backfill: core computes each vector,
 * the store only keeps it. A store deletes a memory's vector and particle when
 * the memory is deleted (hippo.db does it by trigger and foreign-key cascade). */
export interface VectorWrites {
  /** Memories of any kind with no vector stored under `query.model`, by id ascending in byte order. */
  entriesWithoutVector(query: VectorBackfillQuery): Promise<MemoryEntry[]>;
  /** In one transaction: refuses with `modelMismatch` if `replacesIndex` and not `replaceIndex`; else drops every
   * vector and particle if `replacesIndex`, keeps each writable row (memory in `tenantId`, finite non-empty vector)
   * under `model` with its particle, sets `model`. No audit row. */
  writeVectors(write: VectorWrite): Promise<VectorWriteResult>;
}
