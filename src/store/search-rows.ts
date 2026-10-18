import type { MemoryEntry } from '../core/memory.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../core/search-types.js';
import type { OriginFilter } from './port/types.js';
import { onHandle, openStore } from './sqlite/handles.js';
import { loadRecallEntriesAt } from './sqlite/search-rows.js';

/** Positional root form of `loadRecallEntriesAt`; the frozen q3b-ranker-floor benchmark imports it from dist. */
export function loadRecallSearchEntries(
  hippoRoot: string,
  query: string,
  limit: number = DEFAULT_SEARCH_CANDIDATE_LIMIT,
  tenantId?: string,
  requestedScope?: string,
  explicitScopeMode: 'exact' | 'additive' = 'exact',
  includeSuperseded = true,
  originProjects?: OriginFilter,
  ownScope?: string,
): MemoryEntry[] {
  const options = { limit, tenantId, requestedScope, explicitScopeMode, includeSuperseded, originProjects, ownScope };
  return onHandle(hippoRoot, (db) => loadRecallEntriesAt(db, query, options), openStore);
}
