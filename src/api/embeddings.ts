// The vector side of a store for the embed and import verbs: embed what is missing, count coverage, re-seed physics.
// Vectors and physics rows carry no tenant, so each op covers the whole store and needs the host admin.

import type { EmbeddingProvider } from '../embeddings/provider.js';
import { embedAll, folderIndex } from '../search/embed-memories.js';
import { requireHostAdmin, type ContextWith } from './types.js';

type LocalContext = ContextWith<'localFiles'>;

/** Embed every memory that has no vector yet; resolves to how many it embedded. */
export async function embedMissingMemories(ctx: LocalContext, provider?: EmbeddingProvider): Promise<number> {
  requireHostAdmin(ctx, 'Embedding the store');
  const target = folderIndex({ root: ctx.hippoRoot, store: ctx.store, config: ctx.config });
  return embedAll(target, undefined, provider);
}

/** How many vectors the store holds, live memory or not. */
export function storedVectorCount(ctx: LocalContext): number {
  requireHostAdmin(ctx, 'Reading the vector index');
  return ctx.store.localFiles.embeddingIndex.summary().ids.size;
}

export interface EmbedCoverage {
  /** Every memory id in the store. */
  memoryIds: string[];
  /** Every id with a stored vector, including orphans whose memory is gone. */
  vectorIds: string[];
}

/** Memory ids against vector ids, for the embed status and backfill lines. */
export function embedCoverage(ctx: LocalContext): EmbedCoverage {
  requireHostAdmin(ctx, 'Reading the vector index');
  const index = ctx.store.localFiles.embeddingIndex;
  return { memoryIds: index.entryIds(), vectorIds: [...index.summary().ids] };
}

/** Re-seed every memory's physics particle from its vector; returns how many it reset. */
export function resetPhysicsFromVectors(ctx: LocalContext): number {
  requireHostAdmin(ctx, 'Resetting physics');
  const index = ctx.store.localFiles.embeddingIndex;
  return index.resetParticles(index.entryIds(), index.vectors());
}
