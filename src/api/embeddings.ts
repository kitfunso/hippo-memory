// The vector side of a store for the embed and import verbs: embed what is missing, count coverage, re-seed physics.
// Vectors and physics rows carry no tenant, so each op covers the whole store and needs the host admin.

import type { EmbeddingProvider } from '../base/ports/embedder.js';
import { embedAll, folderIndex } from '../domain/search/embed-memories.js';
import type { VectorCoverage } from '../store/port.js';
import { infraOf } from './infra.js';
import { requireHostAdmin, type Context, type ContextWith } from './types.js';

// The embedding target of a folder's store, which a capture embeds its new rows into.
export { folderIndex } from '../domain/search/embed-memories.js';

/** Embed every memory that has no vector yet; resolves to how many it embedded. */
export async function memoryEmbedMissing(ctx: Context, provider?: EmbeddingProvider): Promise<number> {
  requireHostAdmin(ctx, 'Embedding the store');
  const { embedderFor } = infraOf(ctx);
  return embedAll(folderIndex({ store: ctx.store, config: ctx.config, embedderFor }), undefined, provider);
}

/** How many vectors the store holds, live memory or not. */
export async function storedVectorCount(ctx: ContextWith<'embeddingIndex'>): Promise<number> {
  return (await embedCoverage(ctx)).vectors;
}

/** Memories against vectors, counted in the store, for the embed status and backfill lines. */
export async function embedCoverage(ctx: ContextWith<'embeddingIndex'>): Promise<VectorCoverage> {
  requireHostAdmin(ctx, 'Reading the vector index');
  return ctx.store.embeddingIndex.coverage();
}

/** Re-seed every memory's physics particle from its vector; returns how many it reset. */
export async function resetPhysicsFromVectors(ctx: ContextWith<'embeddingIndex'>): Promise<number> {
  requireHostAdmin(ctx, 'Resetting physics');
  return ctx.store.embeddingIndex.resetParticles();
}
