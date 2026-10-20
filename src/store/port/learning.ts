// The store work of the learn passes, kept apart from port.ts. Plain return values, like the rest of LocalFiles.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { EntryCursor, EntryPage } from './types.js';

/** What auto-learn, extraction and invalidation read and write on hippo.db. */
export interface Learning {
  /** A page of the memories whose content shares a token with `tokens`, plus those carrying exactly `tag`, by created
   * then id; read `next` until it is null for all of them. */
  entriesMentioning(
    tokens: readonly string[],
    tag: string,
    tenantId: string,
    page: { readonly limit: number; readonly after?: EntryCursor },
  ): EntryPage;
  /** The row with `id`; null when absent or in another tenant. */
  readEntry(id: string, tenantId: string): MemoryEntry | null;
  /** Rows of `tenantId` that are current and whose origin project is one of `origins`. */
  currentEntriesFromOrigins(tenantId: string, origins: readonly string[]): MemoryEntry[];
  /** Writes one memory; throws RejectedValueError when its value was rejected. */
  writeEntry(entry: MemoryEntry): void;
  /** Writes the rows in one transaction and returns how many. */
  writeEntriesTogether(entries: readonly MemoryEntry[]): number;
  /** Adds `tag` to each of the tenant's rows `ids` names that lacks it, in one transaction. */
  addTagToEntries(tenantId: string, ids: readonly string[], tag: string): void;
  /** When each memory was last confirmed by a good outcome at or after `since` (an ISO time), by id. */
  confirmedOutcomeTimes(tenantId: string, since: string): Map<string, string>;
}
