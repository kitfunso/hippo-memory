// The vector side of a store for the embed and import verbs: embed what is missing, count coverage, re-seed physics.
// Vectors and physics rows carry no tenant, so each op covers the whole store and needs the host admin.

import type { EmbeddingProvider } from '../embeddings/provider.js';
import { embedAll } from '../store/embeddings/index.js';
import { loadAllEntries, loadAllEntryIds } from '../store/entry-reads.js';
import { loadEmbeddingIndex, resetStoredParticles } from '../store/vector-index.js';
import { requireHostAdmin, type Context } from './types.js';

/** Embed every memory that has no vector yet; resolves to how many it embedded. */
export async function embedMissingMemories(ctx: Context, provider?: EmbeddingProvider): Promise<number> {
  requireHostAdmin(ctx, 'Embedding the store');
  return embedAll(ctx.hippoRoot, undefined, provider);
}

/** How many vectors the store holds, live memory or not. */
export function storedVectorCount(ctx: Context): number {
  requireHostAdmin(ctx, 'Reading the vector index');
  return Object.keys(loadEmbeddingIndex(ctx.hippoRoot)).length;
}

export interface EmbedCoverage {
  /** Every memory id in the store. */
  memoryIds: string[];
  /** Every id with a stored vector, including orphans whose memory is gone. */
  vectorIds: string[];
}

/** Memory ids against vector ids, for the embed status and backfill lines. */
export function embedCoverage(ctx: Context): EmbedCoverage {
  requireHostAdmin(ctx, 'Reading the vector index');
  const memoryIds = loadAllEntries(ctx.hippoRoot).map((entry) => entry.id);
  return { memoryIds, vectorIds: Object.keys(loadEmbeddingIndex(ctx.hippoRoot)) };
}

/** Re-seed every memory's physics particle from its vector; returns how many it reset. */
export function resetPhysicsFromVectors(ctx: Context): number {
  requireHostAdmin(ctx, 'Resetting physics');
  const vectors = loadEmbeddingIndex(ctx.hippoRoot);
  return resetStoredParticles(ctx.hippoRoot, loadAllEntryIds(ctx.hippoRoot), vectors);
}
