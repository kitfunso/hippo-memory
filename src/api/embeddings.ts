// The vector side of a store for the embed and import verbs: embed what is missing, count coverage,
// re-seed physics. Vectors and physics rows carry no tenant, so each op covers the whole store and
// needs the host admin.

import type { ConfiguredFolder } from '../base/config/configured-folder.js';
import type { MemoryEntry } from '../base/memory/entry.js';
import type { EmbeddingProvider } from '../base/ports/embedder.js';
import {
  embedAll,
  embedMemoryDetached,
  folderEmbedTarget,
  indexStep,
  type EmbedRun,
} from '../domain/search/embed-memories.js';
import type { HippoStore, VectorCoverage } from '../base/ports/store.js';
import { requireHostAdmin, type Context, type ContextWith } from './types.js';

/** Embeds each row a capture writes into `folder`'s index without holding the capture up; a
 * failure is a warning. A capture runs outside any Context, so its root hands the eval switches
 * and clock as `run`. */
export function detachedEmbedder(
  folder: ConfiguredFolder<HippoStore>,
  run: EmbedRun,
): (entry: MemoryEntry) => void {
  const target = folderEmbedTarget(folder, run);
  return (entry) => embedMemoryDetached(target, entry);
}

/** Embed every memory that has no vector yet; resolves to how many it embedded. */
export async function memoryEmbedMissing(
  ctx: Context,
  provider?: EmbeddingProvider,
): Promise<number> {
  requireHostAdmin(ctx, 'Embedding the store');
  const target = folderEmbedTarget(
    { store: ctx.store, config: ctx.config, embedderFor: ctx.infra.embedderFor },
    ctx.infra,
  );
  return embedAll(target, undefined, provider);
}

/** How many vectors the store holds, live memory or not. */
export async function storedVectorCount(ctx: ContextWith<'embeddingIndex'>): Promise<number> {
  return (await embedCoverage(ctx)).vectors;
}

/** Memories against vectors, counted in the store, for the embed status and backfill lines. */
export async function embedCoverage(ctx: ContextWith<'embeddingIndex'>): Promise<VectorCoverage> {
  requireHostAdmin(ctx, 'Reading the vector index');
  return indexStep(ctx.store.embeddingIndex, { kind: 'coverage' });
}

/** Re-seed every memory's physics particle from its vector; returns how many it reset. */
export async function resetPhysicsFromVectors(ctx: ContextWith<'embeddingIndex'>): Promise<number> {
  requireHostAdmin(ctx, 'Resetting physics');
  return indexStep(ctx.store.embeddingIndex, { kind: 'reset' });
}
