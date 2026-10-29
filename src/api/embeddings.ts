// The vector side of a store for the embed and import verbs: embed what is missing and count
// coverage. Vectors carry no tenant, so each op covers the whole store and needs the host admin.

import type { ConfiguredFolder } from '../base/config/configured-folder.js';
import type { MemoryEntry } from '../base/memory/entry.js';
import type { EmbeddingProvider } from '../base/ports/embedder.js';
import type { InfraPorts } from '../base/ports/infra.js';
import {
  embedAll,
  embedMemoryDetached,
  folderEmbedTarget,
} from '../domain/search/embed-memories.js';
import { indexStep } from '../domain/search/embed-index-target.js';
import type { DetachedWork } from '../domain/search/detached-work.js';
import type { RequiredStore, VectorCoverage } from '../base/ports/store.js';
import { requireHostAdmin, type Context, type ContextWith } from './types.js';

/** Embeds each row a capture writes into `folder`'s index without holding the capture up; a
 * failure is a warning. A capture has no Context: its root hands `run` and the embeds' keeper. */
export function detachedEmbedder(
  folder: ConfiguredFolder<RequiredStore>,
  run: Pick<InfraPorts, 'failureNotices'>,
  detached: DetachedWork,
): (entry: MemoryEntry) => void {
  const target = folderEmbedTarget(folder, run);
  return (entry) => embedMemoryDetached(target, entry, detached);
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
