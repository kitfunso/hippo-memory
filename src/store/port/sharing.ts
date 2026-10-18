// The store work of sharing between a project store and the operator's global store, kept apart from port.ts. Plain
// return values, like the rest of LocalFiles, save sourceTallies, which hippo_peers reads on a served store's worker.
import type { MemoryEntry } from '../../core/memory.js';
import type { OriginFilter } from './types.js';

/** What share, auto-share, sync down and the two-store search read and write on one hippo.db. */
export interface Sharing {
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
  sourceTallies(tenantId?: string): Promise<SourceTally[]>;
  /** The lexical candidates for `query`, with no scope rule. */
  searchEntries(query: string, limit: number | undefined, tenantId: string | undefined): MemoryEntry[];
  /** The lexical candidates for `query` under recall's scope rules. */
  recallEntries(query: string, options: RecallSearchEntriesOptions): MemoryEntry[];
}

export interface SourceTally {
  source: string;
  count: number;
  latest: string;
  /** `created`, a unit separator, then `id` of the source's first row in loadAllEntries' order. */
  first: string;
}

/** Row traits any one of which lets a row through loadEntriesWithSignals. */
export interface EntrySignals {
  tags: readonly string[];
  sourcePrefix: string;
  minRetrievals: number;
  valences: readonly string[];
}

export interface EntryTextKey {
  id: string;
  tenant_id: string;
  content: string;
  source: string;
}

export interface RecallSearchEntriesOptions {
  readonly limit?: number;
  readonly tenantId?: string;
  readonly requestedScope?: string;
  readonly explicitScopeMode?: 'exact' | 'additive';
  readonly includeSuperseded?: boolean;
  readonly originProjects?: OriginFilter;
  readonly ownScope?: string;
}
