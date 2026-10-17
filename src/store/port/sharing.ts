// The store work of sharing between a project store and the operator's global store, kept apart from port.ts. Plain
// return values, like the rest of LocalFiles; whole-row reads and single writes go through Learning.
import type { MemoryEntry } from '../../core/memory.js';
import type { SourceTally } from '../candidates.js';
import type { EntrySignals, EntryTextKey } from '../entry-reads.js';
import type { RecallSearchEntriesOptions } from '../search-rows.js';

/** What share, auto-share, sync down and the two-store search read and write on one hippo.db. */
export interface Sharing {
  /** Creates the store's files when they are missing, as a first share needs. */
  ensureFiles(): void;
  /** The memories that carry any of `signals`, of `tenantId` or of every tenant. */
  entriesWithSignals(signals: EntrySignals, tenantId?: string): MemoryEntry[];
  /** The id, tenant, source and text of every memory of `tenantId` or of every tenant, oldest first. */
  textKeys(tenantId?: string): EntryTextKey[];
  /** The memories with these ids, in any tenant; at most 500 ids a call. */
  entriesByIds(ids: readonly string[]): MemoryEntry[];
  /** Writes the rows `fill` puts in one transaction; a rejected value is audited and `put` answers false. Returns how
   * many it wrote. */
  writeSkippingRejected(fill: (put: (entry: MemoryEntry) => boolean) => void): number;
  /** How many memories each source holds, of `tenantId` or of every tenant. */
  sourceTallies(tenantId?: string): SourceTally[];
  /** The lexical candidates for `query`, with no scope rule. */
  searchEntries(query: string, limit: number | undefined, tenantId: string | undefined): MemoryEntry[];
  /** The lexical candidates for `query` under recall's scope rules. */
  recallEntries(query: string, options: RecallSearchEntriesOptions): MemoryEntry[];
}
