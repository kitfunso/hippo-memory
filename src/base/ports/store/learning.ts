// The reads and the tag write of the learn passes, kept apart from port.ts; their row writes go
// through entryWrites and lessonWrites.
import type { MemoryEntry } from '../../memory/entry.js';
import type { EntryCursor, EntryPage } from './types.js';
import type { MethodEffects } from './effects.js';

/** What auto-learn, extraction and invalidation read and write on hippo.db. */
export interface Learning {
  /** A page of the memories whose content shares a token with `tokens`, plus those carrying
   * exactly `tag`, by created then id; read `next` until it is null for all of them. */
  entriesMentioning(
    tokens: readonly string[],
    tag: string,
    tenantId: string,
    page: { readonly limit: number; readonly after?: EntryCursor },
  ): Promise<EntryPage>;
  /** The row with `id`; null when absent or in another tenant. */
  readEntry(id: string, tenantId: string): Promise<MemoryEntry | null>;
  /** Adds `tag` to each of the tenant's rows `ids` names that lacks it, in one transaction. */
  addTagToEntries(tenantId: string, ids: readonly string[], tag: string): Promise<void>;
  /** When each memory was last confirmed by a good outcome at or after `since` (an ISO time), by
   * id. */
  confirmedOutcomeTimes(tenantId: string, since: string): Promise<Map<string, string>>;
}

/** What each Learning method does to the store; every adapter honours it. */
export const LEARNING_EFFECTS = {
  entriesMentioning: 'read',
  readEntry: 'read',
  addTagToEntries: 'write',
  confirmedOutcomeTimes: 'read',
} as const satisfies MethodEffects<Learning>;
