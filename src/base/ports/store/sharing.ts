import type { MemoryEntry } from '../../memory/entry.js';
import type { TenantId } from '../../util/tenant.js';
import type { EntryFilter, PageRequest } from './reports.js';
import type { EntryCursor, EntryPage, OriginFilter } from './types.js';
import type { MethodEffects } from './effects.js';

export interface Sharing {
  entriesWithSignals(
    signals: EntrySignals,
    tenantId: TenantId,
    page: PageRequest,
  ): Promise<EntryPage>;
  textKeysPage(tenantId: TenantId, page: PageRequest): Promise<EntryTextKeyPage>;
  textKeysHolding(filter: EntryFilter, texts: readonly string[]): Promise<EntryTextKey[]>;
  takenIds(ids: readonly string[]): Promise<string[]>;
  sourceTallies(tenantId: TenantId): Promise<SourceTally[]>;
  searchEntries(
    query: string,
    limit: number | undefined,
    tenantId: TenantId,
  ): Promise<MemoryEntry[]>;
  recallEntries(query: string, options: RecallSearchEntriesOptions): Promise<MemoryEntry[]>;
}

/** What each Sharing method does to the store; every adapter honours it. */
export const SHARING_EFFECTS = {
  entriesWithSignals: 'read',
  textKeysPage: 'read',
  textKeysHolding: 'read',
  takenIds: 'read',
  sourceTallies: 'read',
  searchEntries: 'read',
  recallEntries: 'read',
} as const satisfies MethodEffects<Sharing>;

export interface SourceTally {
  source: string;
  count: number;
  latest: string;
  first: string;
}

/** Row traits any one of which lets a row through listEntriesWithSignals. */
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
  leadIn?: string | null;
  source: string;
}

export interface EntryTextKeyPage {
  readonly keys: EntryTextKey[];
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

/** How a promoted copy is written: the actor its `remember` row names and the local row it
 * copies. */
export interface PromotedCopy {
  readonly actor?: string;
  readonly sourceId: string;
  readonly auditAs?: { readonly tenantId: string; readonly actor: string };
}

export interface Promotion {
  writeCopy(copy: MemoryEntry, opts: PromotedCopy): Promise<void>;
}

/** What each Promotion method does to the store; every adapter honours it. */
export const PROMOTION_EFFECTS = {
  writeCopy: 'write',
} as const satisfies MethodEffects<Promotion>;
