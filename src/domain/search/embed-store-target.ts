// The vector-groups adapter: vector pages written through a store, under the same embed turn.
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { EmbeddingProvider } from '../../base/ports/embedder.js';
import {
  embeddingIndexIdentity,
  embeddingInputText,
  indexedModel,
  indexNeedsRebuild,
  replacesIndex,
} from '../../base/embeddings/index-identity.js';
import type {
  VectorRowWrite,
  VectorWrite,
  VectorWriteResult,
  VectorWrites,
  CoreGroups,
} from '../../base/ports/store.js';
import { errorMessage } from '../../base/util/log.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type { EmbedOutcome, EmbedWith, EmbedAdapter } from './embed-memories.js';
import { embedTurns } from './embed-turns.js';
import { noteSkippedEmbedding, warnEmbedFailureOnce, OTHER_MODEL_INDEX } from './embed-failures.js';

const WITHOUT_VECTOR_PAGE = 64;

interface WriteVectorPageOptions {
  readonly writes: VectorWrites;
  readonly write: Pick<VectorWrite, 'model' | 'replaceIndex'>;
  readonly page: readonly MemoryEntry[];
  readonly vectors: readonly number[][];
}

/** Writes one page's vectors, one writeVectors per tenant, and stops at the first refused write. */
async function writeVectorPage({
  writes,
  write,
  page,
  vectors,
}: WriteVectorPageOptions): Promise<VectorWriteResult> {
  const byTenant = new Map<string, VectorRowWrite[]>();
  page.forEach((entry, i) => {
    const vector = vectors[i];
    if (!vector || vector.length === 0) return noteSkippedEmbedding(entry.id);
    const row: VectorRowWrite = { memoryId: entry.id, vector };
    byTenant.set(entry.tenantId, [...(byTenant.get(entry.tenantId) ?? []), row]);
  });
  let written = 0;
  for (const [tenantId, rows] of byTenant) {
    const result = await writes.writeVectors({ ...write, tenantId, rows });
    if (result.modelMismatch) return { written, modelMismatch: true };
    written += result.written;
  }
  return { written, modelMismatch: false };
}

interface BackfillInStoreOptions {
  readonly writes: VectorWrites;
  readonly provider: EmbeddingProvider;
  readonly model: string;
  readonly rebuild: boolean;
}

/** Embeds every memory with no vector under `model`, page by page, so a provider failure keeps
 * the pages written. */
async function backfillInStore({
  writes,
  provider,
  model,
  rebuild,
}: BackfillInStoreOptions): Promise<number> {
  let count = 0;
  let afterId: string | undefined;
  for (;;) {
    const page = await writes.entriesWithoutVector({
      model,
      afterId,
      limit: WITHOUT_VECTOR_PAGE,
      tenantId: ALL_TENANTS,
    });
    if (page.length === 0) return count;
    afterId = page[page.length - 1].id;
    const vectors = await provider.embed(
      page.map((e) => embeddingInputText(e)),
      'passage',
    );
    const result = await writeVectorPage({
      writes,
      write: { model, replaceIndex: rebuild },
      page,
      vectors,
    });
    // Another process rebuilt the index mid-run; every later page would be refused too, after
    // paying the provider for it.
    if (result.modelMismatch) throw new Error(OTHER_MODEL_INDEX);
    count += result.written;
  }
}

/** embedAll on a store: a model change re-embeds every memory, and the first page written drops
 * the old index. */
async function embedAllInStore(
  { groups }: StoreEmbedTarget,
  provider: EmbeddingProvider,
): Promise<number> {
  const { vectors: reads, vectorWrites: writes } = groups;
  return embedTurns.run(await writes.indexKey(), async () => {
    const rebuild = indexNeedsRebuild(indexedModel(await reads.embeddingIndexState()), provider.id);
    return backfillInStore({
      writes,
      provider,
      model: embeddingIndexIdentity(provider.id),
      rebuild,
    });
  });
}

/** embedMemory on a store; like the hippo.db path it resolves whatever fails. Unlike it, it
 * leaves a model change to embedAll, so a stale read here never drops another process's rebuild;
 * the read only saves a paid embed call, as the write refuses another model itself. */
async function embedMemoryInStore(
  target: StoreEmbedTarget,
  provider: EmbeddingProvider,
  entry: MemoryEntry,
): Promise<EmbedOutcome> {
  const { vectors: reads, vectorWrites: writes } = target.groups;
  try {
    const model = embeddingIndexIdentity(provider.id);
    const refused = await embedTurns.run(
      await writes.indexKey(),
      async () =>
        replacesIndex(await reads.embeddingIndexState(), model) ||
        (
          await writeVectorPage({
            writes,
            write: { model, replaceIndex: false },
            page: [entry],
            vectors: await provider.embed([embeddingInputText(entry)], 'passage'),
          })
        ).modelMismatch,
    );
    if (refused) warnEmbedFailureOnce(target.failureNotices, 'index', OTHER_MODEL_INDEX);
    return refused ? 'failed' : 'indexed';
  } catch (err) {
    warnEmbedFailureOnce(target.failureNotices, provider.kind, errorMessage(err), err);
    return 'failed';
  }
}

/** A store's vector groups. */
export interface StoreEmbedTarget extends EmbedWith {
  readonly groups: Pick<CoreGroups, 'vectors' | 'vectorWrites'>;
}

export function storeAdapter(on: StoreEmbedTarget): EmbedAdapter {
  return {
    one: (provider, entry) => embedMemoryInStore(on, provider, entry),
    all: (provider) => embedAllInStore(on, provider),
  };
}
