// The one search-engine choice every ranker over a candidate pool makes: recall's band, MCP's wide
// list, the CLI core and context.

import type { MemoryEntry } from '../../base/memory/entry.js';
import type { PhysicsConfig } from '../../base/rank/physics-config.js';
import type { RankTime, SearchResult } from '../../base/rank/search-types.js';
import { hybridSearch, type HybridSearchOptions } from './hybrid.js';
import { rankPhysics } from './physics-search.js';
import type { VectorSource } from './vector.js';

/**
 * Physics scoring when `physics` holds its config, hybrid otherwise, both on the store `source`
 * names; each caller keeps its own options.
 *
 */
export function searchByEngine(
  source: VectorSource,
  query: string,
  pool: MemoryEntry[],
  physics: PhysicsConfig | null,
  options: Omit<HybridSearchOptions, 'hippoRoot' | 'store' | 'embeddings' | 'source'> & RankTime,
): Promise<SearchResult[]> {
  return physics
    ? rankPhysics(query, pool, { ...options, physicsConfig: physics, source })
    : hybridSearch(query, pool, { ...options, source });
}
