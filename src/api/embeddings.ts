// The vector side of a store for the embed and import verbs: embed what is missing, count coverage, re-seed physics.
// Vectors and physics rows carry no tenant, so each op covers the whole store and needs the host admin.

import type { EmbeddingProvider } from '../embeddings/provider.js';
import { embedAll } from '../search/embed-memories.js';
import { requireGroup, type EmbeddingIndex } from '../store/port.js';
import { configOf } from './config-of.js';
import { requireHostAdmin, type Context } from './types.js';

const indexOf = (ctx: Context): EmbeddingIndex => requireGroup(ctx.store, 'localFiles').embeddingIndex;

/** Embed every memory that has no vector yet; resolves to how many it embedded. */
export async function embedMissingMemories(ctx: Context, provider?: EmbeddingProvider): Promise<number> {
  requireHostAdmin(ctx, 'Embedding the store');
  return embedAll(requireGroup(ctx.store, 'localFiles'), undefined, provider, configOf(ctx).embeddings);
}

/** How many vectors the store holds, live memory or not. */
export function storedVectorCount(ctx: Context): number {
  requireHostAdmin(ctx, 'Reading the vector index');
  return indexOf(ctx).summary().ids.size;
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
  const index = indexOf(ctx);
  return { memoryIds: index.entryIds(), vectorIds: [...index.summary().ids] };
}

/** Re-seed every memory's physics particle from its vector; returns how many it reset. */
export function resetPhysicsFromVectors(ctx: Context): number {
  requireHostAdmin(ctx, 'Resetting physics');
  const index = indexOf(ctx);
  return index.resetParticles(index.entryIds(), index.vectors());
}
