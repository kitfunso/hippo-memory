// Root-keyed entries forms tests call; production code goes through the store port or the At forms.

import type { MemoryEntry } from '../../../src/base/memory/memory.js';
import type { WriteBudget } from '../../../src/base/util/write-budget.js';
import {
  loadAmbientCandidatesAt,
  loadContextCandidatesAt,
  loadTextsHoldingWordsAt,
  tallySourcesAt,
} from '../../../src/store/sqlite/candidates.js';
import {
  commitInChunksAt,
  deleteEntriesInBatchesAt,
  memoriesBackingAmongAt,
} from '../../../src/store/sqlite/delete-and-batch.js';
import type { DormantMemory, ListDormantOpts } from '../../../src/store/port/dormant.js';
import { listDormantRows } from '../../../src/store/sqlite/dormant-rows.js';
import { EVERY_SCOPE } from '../../../src/store/sqlite/rule-sql.js';
import {
  countSessionRawMemoriesAt,
  loadEntriesByIdsAt,
  loadEntryTextKeysPageAt,
  loadFreshRawMemoriesAt,
  loadSessionRawMemoriesAt,
  iterateEveryTenantEntriesAt,
  readEntryAt,
} from '../../../src/store/sqlite/entry-reads.js';
import { writeEntriesTogetherAt, writePromotedEntryAt } from '../../../src/store/sqlite/entry-writes.js';
import { waitingOpener } from '../../../src/store/sqlite/open.js';
import { handlesOf, onHandle, openStore } from '../../../src/store/sqlite/handles.js';
import type { SqlFragment } from '../../../src/db/sql.js';
import { loadRecallEntriesAt, loadSearchEntriesAt } from '../../../src/store/sqlite/search-rows.js';
import type { HeldText } from '../../../src/store/port/types.js';
import type {
  AmbientLoadResult,
  AmbientRecallRequest,
  ContextCandidateFilter,
  RecentOrigins,
} from '../../../src/store/port/context-reads.js';
import type { SourceTally, EntryTextKey, RecallSearchEntriesOptions } from '../../../src/store/port/sharing.js';
import type { FlushComponent, LoadedRows } from '../../../src/store/port/consolidation.js';
import { ALL_TENANTS, type TenantId } from '../../../src/base/util/tenant.js';
import type { EntryCursor } from '../../../src/store/port/types.js';

export {
  appendSessionEvent,
  batchWriteAndDelete,
  loadAmbientTallies,
  loadEmbeddingIndex,
  loadEntities,
  loadRelations,
  loadTenantEntries as loadAllEntries,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  strengthenRetrieved,
  writeEntry,
} from '../../../src/store/sqlite/folder-forms.js';

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
    (db) => loadAmbientCandidatesAt(db, tenantId, { recentNeeded, judge, recall, origins }),
    openStore,
  );
}

export function loadContextCandidates(
  hippoRoot: string,
  tenantId: string,
  filter: ContextCandidateFilter,
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadContextCandidatesAt(db, tenantId, filter), openStore);
}

export function loadTextsHoldingWords(
  hippoRoot: string,
  tenantId: TenantId = ALL_TENANTS,
  words: readonly string[],
  project?: readonly string[],
  admit?: SqlFragment,
): HeldText[] {
  return onHandle(hippoRoot, (db) => loadTextsHoldingWordsAt(db, tenantId, words, project, admit), openStore);
}

export function tallySources(hippoRoot: string, tenantId: TenantId = ALL_TENANTS): SourceTally[] {
  return onHandle(hippoRoot, (db) => tallySourcesAt(db, tenantId), openStore);
}

export function memoriesBackingAmong(hippoRoot: string, ids: readonly string[]): Set<string> {
  return onHandle(hippoRoot, (db) => memoriesBackingAmongAt(db, ids));
}

export function deleteEntry(
  hippoRoot: string,
  id: string,
  opts?: { actor?: string; reason?: string; automatic?: boolean },
): boolean {
  const targets = [{ id, reason: opts?.reason ?? '' }];
  return onHandle(
    hippoRoot,
    (db) => deleteEntriesInBatchesAt(db, { hippoRoot }, targets, opts ?? {})[0] ?? false,
    openStore,
  );
}

export function loadDormantMemories(
  hippoRoot: string,
  tenantId: string,
  opts: ListDormantOpts = {},
  admit?: SqlFragment,
): DormantMemory[] {
  return onHandle(hippoRoot, (db) => listDormantRows(db, tenantId, opts, admit ?? EVERY_SCOPE));
}

export function loadEntriesByIds(
  hippoRoot: string,
  ids: readonly string[],
  tenantId: TenantId = ALL_TENANTS,
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadEntriesByIdsAt(db, ids, tenantId), openStore);
}

export function loadSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId: TenantId = ALL_TENANTS,
  cap?: number,
  origins?: readonly string[],
): MemoryEntry[] {
  return onHandle(
    hippoRoot,
    (db) => loadSessionRawMemoriesAt(db, { sessionId, tenantId, cap: cap ?? 0, origins }),
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
    (db) => countSessionRawMemoriesAt(db, { sessionId, tenantId, scope, ownScope, origins }),
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
  return onHandle(hippoRoot, (db) => loadFreshRawMemoriesAt(db, count, tenantId, sessionId, origins), openStore);
}

export function readEntry(hippoRoot: string, id: string, tenantId: TenantId = ALL_TENANTS): MemoryEntry | null {
  return onHandle(hippoRoot, (db) => readEntryAt(db, id, tenantId), openStore);
}

export function loadEveryTenantEntries(hippoRoot: string): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => [...iterateEveryTenantEntriesAt(db)], openStore);
}

export function loadEntryTextKeys(hippoRoot: string, tenantId: TenantId = ALL_TENANTS, pageRows = 500): EntryTextKey[] {
  return onHandle(
    hippoRoot,
    (db) => {
      const keys: EntryTextKey[] = [];
      for (let after: EntryCursor | null | undefined; after !== null;) {
        const page = loadEntryTextKeysPageAt(db, tenantId, { limit: pageRows, after });
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
  return onHandle(hippoRoot, (db) => writeEntriesTogetherAt(db, { hippoRoot }, entries), openStore);
}

export function loadRecallEntries(
  hippoRoot: string,
  query: string,
  options: Partial<RecallSearchEntriesOptions> = {},
): MemoryEntry[] {
  return onHandle(
    hippoRoot,
    (db) => loadRecallEntriesAt(db, query, { ...options, tenantId: options.tenantId ?? ALL_TENANTS }),
    openStore,
  );
}

export function commitInChunks(
  hippoRoot: string,
  components: readonly FlushComponent[],
  opts: { snapshot: LoadedRows; budget: WriteBudget; busyWaitMs: number },
): Promise<string[]> {
  return handlesOf(hippoRoot).onAsync(
    (db, files) => commitInChunksAt(db, files, components, opts),
    waitingOpener(opts.busyWaitMs, openStore),
  );
}

export function loadSearchEntries(
  hippoRoot: string,
  query: string,
  limit?: number,
  tenantId: TenantId = ALL_TENANTS,
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadSearchEntriesAt(db, query, limit, tenantId), openStore);
}

export function writePromotedEntry(
  hippoRoot: string,
  entry: MemoryEntry,
  opts: Parameters<typeof writePromotedEntryAt>[3],
): void {
  onHandle(hippoRoot, (db) => writePromotedEntryAt(db, { hippoRoot }, entry, opts), openStore);
}
