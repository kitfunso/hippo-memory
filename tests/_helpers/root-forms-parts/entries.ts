// Root-keyed entries forms tests call; production code goes through the port or the handle-first forms.

import type { MemoryEntry } from '../../../src/base/memory/entry.js';
import type { WriteBudget } from '../../../src/base/util/write-budget.js';
import * as candidatesSql from '../../../src/store/sqlite/candidates.js';
import { evalSwitches } from '../../../src/infra/eval-switches.js';
import { deleteEntriesInBatches } from '../../../src/store/sqlite/delete-and-batch.js';
import * as deleteAndBatchSql from '../../../src/store/sqlite/delete-and-batch.js';
import type { DormantMemory, ListDormantOptions } from '../../../src/base/ports/store/dormant.js';
import { listDormantRows } from '../../../src/store/sqlite/dormant-rows.js';
import { EVERY_SCOPE } from '../../../src/store/sqlite/rule-sql.js';
import { listEntryTextKeysPage, iterateEveryTenantEntries } from '../../../src/store/sqlite/entry-reads.js';
import { listEntriesWhere } from '../../../src/store/sqlite/entry-filter.js';
import * as entryReadsSql from '../../../src/store/sqlite/entry-reads.js';
import * as entryWritesSql from '../../../src/store/sqlite/entry-writes.js';
import { waitingOpener } from '../../../src/store/sqlite/open.js';
import { openStore } from '../../../src/store/sqlite/handles.js';
import type { SqlFragment } from '../../../src/db/sql.js';
import * as searchRowsSql from '../../../src/store/sqlite/search-rows.js';
import type { HeldText, EntryCursor } from '../../../src/base/ports/store/types.js';
import type {
  AmbientLoadResult,
  AmbientRecallRequest,
  ContextCandidateFilter,
  RecentOrigins,
} from '../../../src/base/ports/store/context-reads.js';
import type { SourceTally, EntryTextKey, RecallSearchEntriesOptions } from '../../../src/base/ports/store/sharing.js';
import type { FlushComponent, LoadedRows } from '../../../src/base/ports/store/consolidation.js';
import { ALL_TENANTS, type TenantId } from '../../../src/base/util/tenant.js';
import { READ_PAGE_ROWS, rowsInPages } from '../../../src/base/util/pages.js';
import { handlesOf, onHandle, storeFilesOf } from '../test-session.js';

export {
  batchWriteAndDeleteInFolder,
  countAmbientInFolder,
  loadEmbeddingIndex,
  writeEntry,
} from '../../../src/store/sqlite/fixtures.js';
export { strengthenRetrieved } from '../../../src/store/sqlite/entry-writes.js';

/** One tenant's entries, oldest first. */
export function loadAllEntries(hippoRoot: string, tenantId: string): MemoryEntry[] {
  const page = (db: Parameters<typeof listEntriesWhere>[0]) => (after?: EntryCursor) =>
    listEntriesWhere(db, { tenantId }, { limit: READ_PAGE_ROWS, after });
  return onHandle(hippoRoot, (db) => Array.from(rowsInPages(page(db))), openStore);
}

export function loadAmbientCandidates(
  hippoRoot: string,
  tenantId: string,
  recentNeeded: number,
  admit: (e: MemoryEntry) => boolean,
  recall?: AmbientRecallRequest,
  origins?: RecentOrigins,
): AmbientLoadResult {
  const judge = (e: MemoryEntry) => (admit(e) ? null : ('admission' as const));
  return onHandle(
    hippoRoot,
    (db) => candidatesSql.listAmbientCandidates(db, tenantId, { recentNeeded, judge, recall, origins }),
    openStore,
  );
}

export function loadContextCandidates(
  hippoRoot: string,
  tenantId: string,
  filter: ContextCandidateFilter,
): MemoryEntry[] {
  return onHandle(
    hippoRoot,
    (db) => candidatesSql.listContextCandidates(db, evalSwitches().strength, tenantId, filter),
    openStore,
  );
}

export function loadTextsHolding(
  hippoRoot: string,
  tenantId: TenantId = ALL_TENANTS,
  texts: readonly string[],
  project?: readonly string[],
  admit?: SqlFragment,
): HeldText[] {
  return onHandle(
    hippoRoot,
    (db) => candidatesSql.listTextsHolding(db, { tenantId, texts, project, admit }),
    openStore,
  );
}

export function tallySources(hippoRoot: string, tenantId: TenantId = ALL_TENANTS): SourceTally[] {
  return onHandle(hippoRoot, (db) => candidatesSql.tallySources(db, tenantId), openStore);
}

export function memoriesBackingAmong(hippoRoot: string, ids: readonly string[]): Set<string> {
  return onHandle(hippoRoot, (db) => deleteAndBatchSql.memoriesBackingAmong(db, ids));
}

export function deleteEntry(
  hippoRoot: string,
  id: string,
  opts?: { actor?: string; reason?: string; automatic?: boolean },
): boolean {
  const targets = [{ id, reason: opts?.reason ?? '' }];
  return onHandle(
    hippoRoot,
    (db) => deleteEntriesInBatches(db, storeFilesOf(hippoRoot), targets, opts ?? {})[0] ?? false,
    openStore,
  );
}

export function loadDormantMemories(
  hippoRoot: string,
  tenantId: string,
  opts: ListDormantOptions = {},
  admit?: SqlFragment,
): DormantMemory[] {
  return onHandle(hippoRoot, (db) => listDormantRows(db, tenantId, opts, admit ?? EVERY_SCOPE));
}

export function loadEntriesByIds(
  hippoRoot: string,
  ids: readonly string[],
  tenantId: TenantId = ALL_TENANTS,
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => entryReadsSql.readEntriesInIdOrder(db, ids, tenantId), openStore);
}

export function loadSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId: TenantId = ALL_TENANTS,
  cap?: number,
  origins?: readonly string[],
): MemoryEntry[] {
  if (!sessionId) return [];
  const raws = { tenantId, kinds: ['raw'], live: true, sessionId, origins: origins && ['', ...origins] } as const;
  return onHandle(
    hippoRoot,
    (db) =>
      cap !== undefined && cap > 0
        ? listEntriesWhere(db, raws, { limit: cap, newest: true }).entries.reverse()
        : Array.from(
            rowsInPages((after?: EntryCursor) => listEntriesWhere(db, raws, { limit: READ_PAGE_ROWS, after })),
          ),
    openStore,
  );
}

export function countSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId: TenantId = ALL_TENANTS,
  scope?: string,
  ownScope?: string,
  origins?: readonly string[],
): number {
  return onHandle(
    hippoRoot,
    (db) => entryReadsSql.countSessionRawMemories(db, { sessionId, tenantId, scope, ownScope, origins }),
    openStore,
  );
}

export function loadFreshRawMemories(
  hippoRoot: string,
  count: number,
  tenantId: TenantId = ALL_TENANTS,
  sessionId?: string,
  origins?: readonly string[],
): MemoryEntry[] {
  return onHandle(
    hippoRoot,
    (db) => entryReadsSql.listFreshRawMemories(db, count, tenantId, sessionId, origins),
    openStore,
  );
}

export function readEntry(hippoRoot: string, id: string, tenantId: TenantId = ALL_TENANTS): MemoryEntry | null {
  return onHandle(hippoRoot, (db) => entryReadsSql.readEntry(db, id, tenantId), openStore);
}

export function loadEveryTenantEntries(hippoRoot: string): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => [...iterateEveryTenantEntries(db)], openStore);
}

export function loadEntryTextKeys(hippoRoot: string, tenantId: TenantId = ALL_TENANTS, pageRows = 500): EntryTextKey[] {
  return onHandle(
    hippoRoot,
    (db) => {
      const keys: EntryTextKey[] = [];
      for (let after: EntryCursor | null | undefined; after !== null;) {
        const page = listEntryTextKeysPage(db, tenantId, { limit: pageRows, after });
        keys.push(...page.keys);
        after = page.next;
      }
      return keys;
    },
    openStore,
  );
}

export function writeEntriesTogether(hippoRoot: string, entries: readonly MemoryEntry[]): number {
  if (entries.length === 0) return 0;
  return onHandle(
    hippoRoot,
    (db) => entryWritesSql.writeEntriesTogether(db, storeFilesOf(hippoRoot), entries),
    openStore,
  );
}

export function loadRecallEntries(
  hippoRoot: string,
  query: string,
  options: Partial<RecallSearchEntriesOptions> = {},
): MemoryEntry[] {
  return onHandle(
    hippoRoot,
    (db) => searchRowsSql.listRecallEntries(db, query, { ...options, tenantId: options.tenantId ?? ALL_TENANTS }),
    openStore,
  );
}

export function commitInChunks(
  hippoRoot: string,
  components: readonly FlushComponent[],
  opts: { snapshot: LoadedRows; budget: WriteBudget; busyWaitMs: number },
): Promise<string[]> {
  return handlesOf(hippoRoot).onAsync(
    (db, files) => deleteAndBatchSql.commitInChunks(db, files, components, opts),
    waitingOpener(opts.busyWaitMs, openStore),
  );
}

export function loadSearchEntries(
  hippoRoot: string,
  query: string,
  limit?: number,
  tenantId: TenantId = ALL_TENANTS,
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => searchRowsSql.listSearchEntries(db, query, limit, tenantId), openStore);
}

export function writePromotedEntry(
  hippoRoot: string,
  entry: MemoryEntry,
  opts: Parameters<typeof entryWritesSql.writePromotedEntry>[3],
): void {
  onHandle(hippoRoot, (db) => entryWritesSql.writePromotedEntry(db, storeFilesOf(hippoRoot), entry, opts), openStore);
}
