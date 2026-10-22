// What share, auto-share, sync down and the two-store search read on a store; their writes go through lessonWrites.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { TenantId } from '../../base/util/tenant.js';
import type { EntryCursor, EntryPage, OriginFilter } from './types.js';

/** Where a page starts and how many rows it holds at most. */
export interface PageRequest {
  readonly limit: number;
  readonly after?: EntryCursor;
}

export interface Sharing {
  /** A page of the memories of `tenantId` that may carry any of `signals`, oldest first. */
  entriesWithSignals(signals: EntrySignals, tenantId: TenantId, page: PageRequest): Promise<EntryPage>;
  /** A page of the id, tenant, source and text of the memories of `tenantId`, oldest first. */
  textKeysPage(tenantId: TenantId, page: PageRequest): Promise<EntryTextKeyPage>;
  /** The id, tenant, source and text of the memories of `tenantId` that may hold one of `texts` word for word, spacing
   * aside: a superset the caller checks again. */
  textKeysHolding(tenantId: TenantId, texts: readonly string[]): Promise<EntryTextKey[]>;
  /** The ids among `ids` that a memory of any tenant holds. */
  takenIds(ids: readonly string[]): Promise<string[]>;
  /** How many memories of `tenantId` each source holds. */
  sourceTallies(tenantId: TenantId): Promise<SourceTally[]>;
  /** The lexical candidates of `tenantId` for `query`, with no scope rule. */
  searchEntries(query: string, limit: number | undefined, tenantId: TenantId): Promise<MemoryEntry[]>;
  /** The lexical candidates for `query` under recall's scope rules. */
  recallEntries(query: string, options: RecallSearchEntriesOptions): Promise<MemoryEntry[]>;
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

// The global write behind `promote`: a promoted copy written into the operator's global store.
/** How a promoted copy is written: the actor its `remember` row names and the local row it copies. */
export interface PromotedCopy {
  readonly actor?: string;
  readonly sourceId: string;
  /** Also writes one `promote` audit row for the copy ({sourceId}), in the copy's own transaction. */
  readonly auditAs?: { readonly tenantId: string; readonly actor: string };
}

export interface Promotion {
  /** Writes `copy` into this store, the global one; the caller has already vetted, labelled and embeds it. */
  writeCopy(copy: MemoryEntry, opts: PromotedCopy): Promise<void>;
}
