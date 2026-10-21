// The published hybridSearch and physicsSearch: each fills the hippo.db folder default, then calls the domain ranker of
// the same name, which takes its store from the caller. The eval kit's embedMemory and loadRecallSearchEntries take a
// folder the same way.

import type { MemoryEntry } from '../base/memory/memory.js';
import type { SearchResult } from '../base/rank/search-types.js';
import { sqliteStore } from '../store/sqlite/index.js';
import type { OriginFilter } from '../store/port/types.js';
import { loadRecallSearchEntries as loadRecallByOptions } from '../store/search-rows.js';
import type { TenantId } from '../base/util/tenant.js';
import { embedMemory as embedInto, folderIndex, type EmbedOutcome } from '../domain/search/embed-memories.js';
import { hybridSearch as rankHybrid, vectorSourceOf, type HybridSearchOptions } from '../domain/search/hybrid.js';
import { loadConfig } from '../base/config/config.js';
import { resolveEmbeddingProvider } from '../base/embeddings/provider.js';
import { physicsSearch as rankPhysics, type PhysicsSearchOptions } from '../domain/search/physics-search.js';
import type { VectorSource } from '../domain/search/vector.js';

/** hippo.db under `hippoRoot` when the caller passed no store. */
export function folderVectorSource({
  hippoRoot,
  store,
  embeddings,
}: Pick<HybridSearchOptions, 'hippoRoot' | 'store' | 'embeddings'>): VectorSource | undefined {
  if (!hippoRoot) return undefined;
  const config = { embeddings: embeddings ?? loadConfig(hippoRoot).embeddings };
  return vectorSourceOf({
    store: store ?? sqliteStore(hippoRoot),
    config,
    onHippoDb: true,
    embedderFor: resolveEmbeddingProvider,
  });
}

/**
 * BM25 blended with cosine similarity when stored vectors and a provider are available, BM25 * strength * recency
 * otherwise. Reads hippo.db under `hippoRoot` when no `source` or `store` is passed.
 */
export async function hybridSearch(
  query: string,
  entries: MemoryEntry[],
  options: HybridSearchOptions = {},
): Promise<SearchResult[]> {
  // GraphStreamOptions names the global store by folder, so it opens here.
  const globalRoot = options.graphStream?.globalRoot;
  return rankHybrid(query, entries, {
    ...options,
    source: options.source ?? folderVectorSource(options),
    graphGlobal: globalRoot && globalRoot !== options.hippoRoot ? sqliteStore(globalRoot) : undefined,
  });
}

/**
 * Scores memories by gravity, momentum and cluster amplification; rows without physics state rank through hybridSearch.
 * Reads hippo.db under `hippoRoot` when no store is passed.
 */
export async function physicsSearch(
  query: string,
  entries: MemoryEntry[],
  options: PhysicsSearchOptions = {},
): Promise<SearchResult[]> {
  const source = entries.length > 0 ? folderVectorSource(options) : undefined;
  return rankPhysics(query, entries, { ...options, source });
}

/** The eval kit's folder form of embedMemory, for frozen scripts written against it. */
export async function embedMemory(hippoRoot: string, entry: MemoryEntry): Promise<EmbedOutcome> {
  const store = sqliteStore(hippoRoot);
  try {
    return await embedInto(folderIndex({ store, config: loadConfig(hippoRoot) }), entry);
  } finally {
    await store.close();
  }
}

type PositionalRecallArgs = [
  hippoRoot: string,
  query: string,
  limit: number | undefined,
  tenantId: TenantId,
  requestedScope?: string,
  explicitScopeMode?: 'exact' | 'additive',
  includeSuperseded?: boolean,
  originProjects?: OriginFilter,
  ownScope?: string,
];

/** The eval kit's positional form of the recall loader, for frozen scripts written against it. It takes one rest
 * parameter, so the frozen q3b-ranker-floor call stays as written and src declares no long positional list. */
export function loadRecallSearchEntries(...args: PositionalRecallArgs): MemoryEntry[] {
  const [
    hippoRoot,
    query,
    limit,
    tenantId,
    requestedScope,
    explicitScopeMode,
    includeSuperseded,
    originProjects,
    ownScope,
  ] = args;
  return loadRecallByOptions(hippoRoot, query, {
    limit,
    tenantId,
    requestedScope,
    explicitScopeMode,
    includeSuperseded,
    originProjects,
    ownScope,
  });
}
