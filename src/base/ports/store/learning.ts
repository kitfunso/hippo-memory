import type { MemoryEntry } from '../../memory/entry.js';
import type { EntryCursor, EntryPage } from './types.js';
import type { MethodEffects } from './effects.js';

/** What auto-learn, extraction and invalidation read and write on hippo.db. */
export interface Learning {
  entriesMentioning(
    tokens: readonly string[],
    tag: string,
    tenantId: string,
    page: { readonly limit: number; readonly after?: EntryCursor },
  ): Promise<EntryPage>;
  readEntry(id: string, tenantId: string): Promise<MemoryEntry | null>;
  addTagToEntries(tenantId: string, ids: readonly string[], tag: string): Promise<void>;
  confirmedOutcomeTimes(tenantId: string, since: string): Promise<Map<string, string>>;
}

/** What each Learning method does to the store; every adapter honours it. */
export const LEARNING_EFFECTS = {
  entriesMentioning: 'read',
  readEntry: 'read',
  addTagToEntries: 'write',
  confirmedOutcomeTimes: 'read',
} as const satisfies MethodEffects<Learning>;
