// The store work of sharing between a project store and the operator's global store, kept apart from port.ts. Plain
// return values, like the rest of LocalFiles, save sourceTallies, which hippo_peers reads on a served store's worker.
import type { MemoryEntry } from '../../core/memory.js';
import type { EntryCursor, EntryPage } from './consolidation.js';
import type { OriginFilter } from './types.js';

/** Where a page starts and how many rows it holds at most. */
export interface PageRequest {
  readonly limit: number;
  readonly after?: EntryCursor;
}

/** What share, auto-share, sync down and the two-store search read and write on one hippo.db. */
export interface Sharing {
  /** A page of the memories of `tenantId`, or of every tenant when it is undefined, oldest first. */
  entriesPage(tenantId: string | undefined, page: PageRequest): EntryPage;
  /** A page of the memories that may carry any of `signals`, of `tenantId` or of every tenant, oldest first. */
  entriesWithSignals(signals: EntrySignals, tenantId: string | undefined, page: PageRequest): EntryPage;
  /** A page of the id, tenant, source and text of the memories of `tenantId` or of every tenant, oldest first. */
  textKeysPage(tenantId: string | undefined, page: PageRequest): EntryTextKeyPage;
  /** The id, tenant, source and text of the memories of `tenantId`, or of every tenant, that may hold one of `texts`
   * word for word, spacing aside: a superset the caller checks again. */
  textKeysHolding(tenantId: string | undefined, texts: readonly string[]): EntryTextKey[];
  /** The ids among `ids` that a memory of any tenant holds. */
  takenIds(ids: readonly string[]): string[];
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

export interface EntryTextKeyPage {
  readonly keys: EntryTextKey[];
  /** The cursor that reads the page after this one, or null when this was the last. */
  readonly next: EntryCursor | null;
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
