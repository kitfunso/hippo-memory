// Embeds memories into the vector index: picks the adapter for a target and runs embedAll and embedMemoryInto on it.
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { InfraPorts } from '../../base/ports/infra.js';
import type { ConfiguredFolder } from '../../base/config/configured-folder.js';
import type { EmbedderFor, EmbeddingProvider } from '../../base/ports/embedder.js';
import type { EmbeddingsConfig } from '../../base/config/config.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import type { FailureNotices } from '../../base/util/failure-notices.js';
import { warnEmbedFailureOnce } from './embed-failures.js';
import { type IndexRows, type IndexEmbedTarget, indexAdapter } from './embed-index-target.js';
import { type StoreEmbedTarget, storeAdapter } from './embed-store-target.js';
import type { DetachedWork } from './detached-work.js';
import type { HippoStore } from '../../base/ports/store.js';
import type { EmbeddingIndex } from '../../base/ports/store/vectors.js';

/** `off` is a provider that is disabled or not installed, which is a choice; `failed` is a
 * memory that stays out of the vector index. */
export type EmbedOutcome = 'indexed' | 'off' | 'failed';

/** Where vectors go: a store's own index under its lock, or a store's vector groups, with the
 * embeddings config that names the provider and the embedder that builds it. A store with
 * neither has no target, and its rows stay out of every vector search. */
export type EmbedTarget = IndexEmbedTarget | StoreEmbedTarget;

/** The embeddings config, the root's embedder and the failures the root warned about, which
 * every target carries. */
export interface EmbedWith {
  readonly embeddings: EmbeddingsConfig;
  readonly embedderFor: EmbedderFor;
  readonly failureNotices: FailureNotices;
}

/** The root's eval switches and clock, which score and stamp the rows a share or sync writes, and
 * the failures its embeds already warned about. */
export type EmbedRun = Pick<InfraPorts, 'evalSwitches' | 'clock' | 'failureNotices'>;

/** The store's own index when its tier keeps one, else its vector groups. */
export function folderEmbedTarget(
  { store, config, embedderFor }: ConfiguredFolder<EmbedStore>,
  { failureNotices }: Pick<InfraPorts, 'failureNotices'>,
): EmbedTarget {
  const { vectors, vectorWrites } = store;
  const embeddingIndex = store.hippoDb?.embeddingIndex;
  const { embeddings } = config;
  if (embeddingIndex !== undefined) {
    const rows: IndexRows = { entriesByIds: (ids, tenantId) => store.entriesByIds(ids, tenantId) };
    return { embeddingIndex, rows, embeddings, embedderFor, failureNotices };
  }
  const groups = { vectors, vectorWrites };
  return { groups, embeddings, embedderFor, failureNotices };
}

/** A store an embed reaches: its own index when its tier keeps one, else its vector groups. */
export type EmbedStore = HippoStore & {
  // `& object` keeps the maybe-tier from being a weak type, so a tier of only other repos meets it.
  readonly hippoDb?: { readonly embeddingIndex?: EmbeddingIndex } & object;
};

/** What embedding one memory and every memory does on a target: the folder index under its lock, or
 * a store's vector groups under the same per-index turn. */
export interface EmbedAdapter {
  one(provider: EmbeddingProvider, entry: MemoryEntry): Promise<EmbedOutcome>;
  all(provider: EmbeddingProvider): Promise<number>;
}

function adapterFor(on: EmbedTarget): EmbedAdapter {
  return 'groups' in on ? storeAdapter(on) : indexAdapter(on);
}

/** Embed a single memory entry and cache the result in the embedding index; with a store,
 * through its vectorWrites. Resolves whatever fails, so a caller that fires and forgets stays
 * safe; the outcome says whether the memory reached the index. */
export async function embedMemoryInto(
  on: EmbedTarget,
  entry: MemoryEntry,
  model?: string,
): Promise<EmbedOutcome> {
  let provider: EmbeddingProvider;
  let available: boolean;
  try {
    provider = on.embedderFor(on.embeddings, { model });
    available = provider.isAvailable();
  } catch (err) {
    // Callers fire and forget, so this must resolve: a bad config warns once instead of rejecting.
    warnEmbedFailureOnce(on.failureNotices, 'config', errorMessage(err), err);
    return 'failed';
  }
  if (!available) return 'off';
  return adapterFor(on).one(provider, entry);
}

/** embedMemory for a write that does not wait on its vector: `detached` keeps the embed until its
 * root settles it. A rejection outside embedMemory's own handling is logged here. */
export function embedMemoryDetached(
  on: EmbedTarget,
  entry: MemoryEntry,
  detached: DetachedWork,
): void {
  detached.detach(
    embedMemoryInto(on, entry).catch((err) =>
      log.warn(`embedding ${entry.id} failed unexpectedly`, errorFields(err)),
    ),
  );
}

/** Throws when an unavailable provider is a misconfiguration rather than an intentional no-op. */
function throwIfProviderKeyMissing(cfg: EmbeddingsConfig, provider: EmbeddingProvider): void {
  // An enabled API provider is unavailable only when its own read finds no key: a misconfiguration,
  // surfaced so callers of the exported embedAll() learn nothing was written. Local-not-installed
  // and enabled=false stay silent no-ops.
  if (provider.kind !== 'local' && cfg.enabled !== false && provider.keyEnv !== undefined) {
    throw new Error(
      `Embedding provider '${provider.kind}' is configured but ${provider.keyEnv} is not set.`,
    );
  }
}

/** Embeds every entry with no cached vector, prunes vectors of deleted memories, and returns how
 * many it embedded; `provider` defaults to the one the target's embedder builds. With a store,
 * every tenant's memories with no vector for the provider's model go through its `vectorWrites`. */
export async function embedAll(
  on: EmbedTarget,
  model?: string,
  givenProvider?: EmbeddingProvider,
): Promise<number> {
  const cfg = on.embeddings;
  const provider = givenProvider ?? on.embedderFor(cfg, { model });
  if (!provider.isAvailable()) {
    throwIfProviderKeyMissing(cfg, provider);
    return 0;
  }
  return adapterFor(on).all(provider);
}
