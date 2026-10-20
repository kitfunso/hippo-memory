import type { MemoryEntry } from '../base/memory/memory.js';
import type { RecallSearchEntriesOptions } from './local/sharing.js';
import { onHandle, openStore } from './sqlite/handles.js';
import { loadRecallEntriesAt } from './sqlite/search-rows.js';

/** The folder form of `loadRecallEntriesAt`. The eval kit's positional `loadRecallSearchEntries` serves the frozen
 * q3b-ranker-floor benchmark through it. */
export function loadRecallSearchEntries(
  hippoRoot: string,
  query: string,
  options: RecallSearchEntriesOptions,
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadRecallEntriesAt(db, query, options), openStore);
}
