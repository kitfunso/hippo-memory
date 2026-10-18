// The published hybridSearch and physicsSearch: each fills the hippo.db folder default, then calls the domain ranker
// of the same name, which takes its store from the caller.

import type { MemoryEntry } from '../core/memory.js';
import type { SearchResult } from '../core/search-types.js';
import { sqliteStore } from '../store/index.js';
import { hybridSearch as rankHybrid, vectorSourceOf, type HybridSearchOptions } from '../search/hybrid.js';
import { loadConfig } from '../core/config.js';
import { physicsSearch as rankPhysics, type PhysicsSearchOptions } from '../search/physics-search.js';
import type { VectorSource } from '../search/vector.js';

/** hippo.db under `hippoRoot` when the caller passed no store. */
export function folderVectorSource({
  hippoRoot,
  store,
  embeddings,
}: Pick<HybridSearchOptions, 'hippoRoot' | 'store' | 'embeddings'>): VectorSource | undefined {
  if (!hippoRoot) return undefined;
  const config = { embeddings: embeddings ?? loadConfig(hippoRoot).embeddings };
  return vectorSourceOf({ store: store ?? sqliteStore(hippoRoot), config, onHippoDb: true });
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
 * Scores memories by gravity, momentum and cluster amplification; rows without physics state rank through
 * hybridSearch. Reads hippo.db under `hippoRoot` when no store is passed.
 */
export async function physicsSearch(
  query: string,
  entries: MemoryEntry[],
  options: PhysicsSearchOptions = {},
): Promise<SearchResult[]> {
  const source = entries.length > 0 ? folderVectorSource(options) : undefined;
  return rankPhysics(query, entries, { ...options, source });
}
