// The store work of sharing between a project store and the operator's global store, kept apart from port.ts. Plain
// return values, like the rest of LocalFiles, save sourceTallies, which hippo_peers reads on a served store's worker.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { EntryCursor, EntryPage } from '../port/types.js';
import type { OriginFilter } from '../port/types.js';
import type { TenantId } from '../../base/util/tenant.js';

/** Where a page starts and how many rows it holds at most. */
export interface PageRequest {
  readonly limit: number;
  readonly after?: EntryCursor;
}

/** What share, auto-share, sync down and the two-store search read and write on one hippo.db. */
export interface Sharing {
  /** A page of the memories of `tenantId`, oldest first. */
  entriesPage(tenantId: TenantId, page: PageRequest): EntryPage;
  /** A page of the memories of `tenantId` that may carry any of `signals`, oldest first. */
  entriesWithSignals(signals: EntrySignals, tenantId: TenantId, page: PageRequest): EntryPage;
  /** A page of the id, tenant, source and text of the memories of `tenantId`, oldest first. */
  textKeysPage(tenantId: TenantId, page: PageRequest): EntryTextKeyPage;
  /** The id, tenant, source and text of the memories of `tenantId` that may hold one of `texts` word for word, spacing
   * aside: a superset the caller checks again. */
  textKeysHolding(tenantId: TenantId, texts: readonly string[]): EntryTextKey[];
  /** The ids among `ids` that a memory of any tenant holds. */
  takenIds(ids: readonly string[]): string[];
  /** The memories with these ids, in any tenant; at most 500 ids a call. */
  entriesByIds(ids: readonly string[]): MemoryEntry[];
  /** Writes the rows `fill` puts in one transaction; a rejected value is audited and `put` answers false. Returns how
   * many it wrote. */
  writeSkippingRejected(fill: (put: (entry: MemoryEntry) => boolean) => void): number;
  /** How many memories of `tenantId` each source holds. */
  sourceTallies(tenantId: TenantId): Promise<SourceTally[]>;
  /** The lexical candidates of `tenantId` for `query`, with no scope rule. */
  searchEntries(query: string, limit: number | undefined, tenantId: TenantId): MemoryEntry[];
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
  tenantId: string;
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
  readonly tenantId: TenantId;
  readonly requestedScope?: string;
  readonly explicitScopeMode?: 'exact' | 'additive';
  readonly includeSuperseded?: boolean;
  readonly originProjects?: OriginFilter;
  readonly ownScope?: string;
}
