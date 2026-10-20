// A store's own vector index, which the embed and status verbs read and write. Vectors and particles carry no tenant,
// so each method covers the whole store.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { PhysicsParticle } from '../../base/rank/physics.js';

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
  particles(): Promise<PhysicsParticle[]>;
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
  /** Replaces every particle with a fresh one per memory that has a stored vector; answers how many. */
  resetParticles(): Promise<number>;
  /** A first particle for `entry` at `vector`, unless it has one. */
  seedParticle(entry: MemoryEntry, vector: number[]): Promise<void>;
  /** Takes the index's write lock, which other processes on the store honour; a token to unlock, or null while a live
   * holder has it. */
  tryLock(): Promise<string | null>;
  /** Releases the lock `token` took; a lock another holder took since is left. */
  unlock(token: string): Promise<void>;
}

/** One memory's vector. */
export type VectorRow = readonly [memoryId: string, vector: readonly number[]];

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
  readonly ids: Set<string>;
  readonly dims: number | undefined;
}
