// What share, auto-share, sync down and the two-store search read on a store; their writes go through lessonWrites.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { TenantId } from '../../base/util/tenant.js';
import type { EntryCursor, EntryPage, HeldText, OriginFilter } from './types.js';

/** Where a page starts and how many rows it holds at most. */
export interface PageRequest {
  readonly limit: number;
  readonly after?: EntryCursor;
}

export interface Sharing {
  /** A page of the memories of `tenantId`, oldest first. */
  entriesPage(tenantId: TenantId, page: PageRequest): Promise<EntryPage>;
  /** A page of the memories of `tenantId` that may carry any of `signals`, oldest first. */
  entriesWithSignals(signals: EntrySignals, tenantId: TenantId, page: PageRequest): Promise<EntryPage>;
  /** A page of the id, tenant, source and text of the memories of `tenantId`, oldest first. */
  textKeysPage(tenantId: TenantId, page: PageRequest): Promise<EntryTextKeyPage>;
  /** The id, tenant, source and text of the memories of `tenantId` that may hold one of `texts` word for word, spacing
   * aside: a superset the caller checks again. */
  textKeysHolding(tenantId: TenantId, texts: readonly string[]): Promise<EntryTextKey[]>;
  /** The rows holding any of `words`, for the dedup before a write; a row equal to a text apart from spacing holds its
   * every word. `project` keeps rows carrying one of those names plus user-global rows, `everyScope` lifts the
   * team-visible filter for a reader that sees the whole store. */
  textsHolding(tenantId: TenantId, words: readonly string[], opts: TextsHoldingOptions): Promise<HeldText[]>;
  /** The ids among `ids` that a memory of any tenant holds. */
  takenIds(ids: readonly string[]): Promise<string[]>;
  /** The memories with these ids, in any tenant. */
  entriesByIds(ids: readonly string[]): Promise<MemoryEntry[]>;
  /** How many memories of `tenantId` each source holds. */
  sourceTallies(tenantId: TenantId): Promise<SourceTally[]>;
  /** The lexical candidates of `tenantId` for `query`, with no scope rule. */
  searchEntries(query: string, limit: number | undefined, tenantId: TenantId): Promise<MemoryEntry[]>;
  /** The lexical candidates for `query` under recall's scope rules. */
  recallEntries(query: string, options: RecallSearchEntriesOptions): Promise<MemoryEntry[]>;
}

export interface TextsHoldingOptions {
  readonly project?: readonly string[];
  readonly everyScope?: boolean;
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
