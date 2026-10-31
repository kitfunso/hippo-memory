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
import type { HippoStore } from '../base/ports/store.js';
import type { VectorCoverage } from '../base/records/embedding-index.js';
import { requireHostAdmin, type Context } from './types.js';
import type { HippoDbContext } from './hippo-db-context.js';

/** Embeds each row a capture writes into `folder`'s index without holding the capture up; a
 * failure is a warning. A capture has no Context: its root hands `run` and the embeds' keeper. */
export function detachedEmbedder(
  folder: ConfiguredFolder<HippoStore>,
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
export async function storedVectorCount(ctx: HippoDbContext): Promise<number> {
  return (await embedCoverage(ctx)).vectors;
}

/** Memories against vectors, counted in the store, for the embed status and backfill lines. */
export async function embedCoverage(ctx: HippoDbContext): Promise<VectorCoverage> {
  requireHostAdmin(ctx, 'Reading the vector index');
  return indexStep(ctx.store.hippoDb.embeddingIndex, { kind: 'coverage' });
}
