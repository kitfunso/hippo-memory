import type { MemoryEntry } from '../../base/memory/entry.js';
import type { PhysicsConfig } from '../../base/rank/physics-config.js';
import type { RankTime, SearchResult } from '../../base/rank/search-types.js';
import { hybridSearch, type HybridSearchOptions } from './hybrid.js';
import { rankPhysics } from './physics-search.js';
import type { VectorSource } from './vector.js';

export interface SearchByEngineOptions {
  readonly source: VectorSource | undefined;
  readonly query: string;
  readonly pool: MemoryEntry[];
  readonly physics: PhysicsConfig | null;
  readonly options: Omit<HybridSearchOptions, 'hippoRoot' | 'store' | 'embeddings' | 'source'> &
    RankTime;
}

/**
 * Physics scoring when `physics` holds its config, hybrid otherwise, both on the store `source`
 * names; each caller keeps its own options.
 */
export function searchByEngine({
  source,
  query,
  pool,
  physics,
  options,
}: SearchByEngineOptions): Promise<SearchResult[]> {
  return physics
    ? rankPhysics(query, pool, { ...options, physicsConfig: physics, source })
    : hybridSearch(query, pool, { ...options, source });
}
