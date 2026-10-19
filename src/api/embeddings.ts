// The vector side of a store for the embed and import verbs: embed what is missing, count coverage, re-seed physics.
// Vectors and physics rows carry no tenant, so each op covers the whole store and needs the host admin.

import type { EmbeddingProvider } from '../embeddings/provider.js';
import { embedAll, folderIndex } from '../search/embed-memories.js';
import type { VectorCoverage } from '../store/local/embedding-index.js';
import { requireHostAdmin, type ContextWith, type LocalContext } from './types.js';


/** Embed every memory that has no vector yet; resolves to how many it embedded. */
export async function memoryEmbedMissing(ctx: LocalContext, provider?: EmbeddingProvider): Promise<number> {
  requireHostAdmin(ctx, 'Embedding the store');
  const target = folderIndex({ root: ctx.hippoRoot, store: ctx.store, config: ctx.config });
  return embedAll(target, undefined, provider);
}

/** How many vectors the store holds, live memory or not. */
export function storedVectorCount(ctx: LocalContext): number {
  return embedCoverage(ctx).vectors;
}

/** Memories against vectors, counted in the store, for the embed status and backfill lines. */
export function embedCoverage(ctx: LocalContext): VectorCoverage {
  requireHostAdmin(ctx, 'Reading the vector index');
  return ctx.store.localFiles.embeddingIndex.coverage();
}

/** Re-seed every memory's physics particle from its vector; returns how many it reset. */
export function resetPhysicsFromVectors(ctx: LocalContext): number {
  requireHostAdmin(ctx, 'Resetting physics');
  return ctx.store.localFiles.embeddingIndex.resetParticles();
}
