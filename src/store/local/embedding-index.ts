// hippo.db's own vector index: what embedding under its folder lock and the embed and status verbs read and write.
// Vectors and particles carry no tenant, so each method covers the whole store.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { PhysicsParticle } from '../../base/rank/physics.js';
import type { EntryIdPage } from './consolidation.js';
import type { EntryCursor } from '../port/types.js';

export interface EmbeddingIndex {
  /** Whether another model than `providerId` built the stored vectors; an unreadable index answers false. */
  requiresReindex(providerId: string): boolean;
  /** Records `providerId`'s index identity as what built the vectors. */
  saveModel(providerId: string): void;
  entryCount(): number;
  /** Up to `page.limit` memory ids, by created then id, after `page.after`; `next` is null on the last page. */
  entryIdsPage(page: { readonly limit: number; readonly after?: EntryCursor }): EntryIdPage;
  /** The rows of `ids` that exist, in no set order. */
  entriesByIds(ids: readonly string[]): MemoryEntry[];
  summary(): StoredVectorSummary;
  /** How many memories and vectors the store holds, and how many memories have a vector. */
  coverage(): VectorCoverage;
  /** The particle count and mean speed, and every particle only while at most `fullUpTo` are stored. */
  particleStats(fullUpTo: number): ParticleStats;
  /** Upserts each row under `model`, one commit per row so a failure keeps those before it; answers how many. */
  saveVectors(rows: Iterable<readonly [string, readonly number[]]>, model: string): number;
  /** A rebuild whose vectors wait apart from the live index until `commit`; the caller closes it. */
  beginRebuild(): VectorRebuild;
  /** Drops the vectors of deleted memories. */
  pruneOrphans(): void;
  /** Up to `page.limit` ids with no vector, by created then id, after `page.after`; `next` is null on the last page. */
  pendingIds(page: { readonly limit: number; readonly after?: EntryCursor }): EntryIdPage;
  /** Replaces every particle with a fresh one per memory that has a stored vector, reading a page at a time; answers
   * how many. */
  resetParticles(): number;
  /** A first particle for `entry` at `vector`, unless it has one. */
  seedParticle(entry: MemoryEntry, vector: number[]): void;
}

/** `particles` is null past the caller's limit, so a large store is summed a column at a time, never loaded. */
export interface ParticleStats {
  count: number;
  meanSpeed: number;
  particles: PhysicsParticle[] | null;
}

/** Vectors staged by page on a handle of their own, so neither the live index nor the caller holds them all. */
export interface VectorRebuild {
  /** Stages one page of vectors, skipping empty or non-finite ones; answers how many it staged. */
  stage(rows: ReadonlyArray<readonly [string, readonly number[]]>): number;
  /** In one transaction, replaces every stored vector with the staged ones and records `model`, an index identity as
   * saveVectors takes it, as what built them. */
  commit(model: string): void;
  /** Drops what is staged and releases the handle; a rebuild never committed leaves the live index as it was. */
  close(): void;
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
