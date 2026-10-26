// The ./testing entry's hippo.db seams, its one door into the adapter: evals seed and read a store folder, and
// benchmarks a handle they open themselves. The kit is synchronous and the port is not, so each seam runs on a handle.
import type { AmbientTallies } from '../../base/memory/ambient.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type { DormantMove } from '../../base/ports/store/consolidation.js';
import type { AmbientStoreFilter } from '../../base/ports/store/context-reads.js';
import type { RecallSearchEntriesOptions } from '../../base/ports/store/sharing.js';
import * as ambient from './ambient.js';
import * as batches from './delete-and-batch.js';
import * as entryReads from './entry-reads.js';
import * as entryWrites from './entry-writes.js';
import type { WriteEntryOptions } from './entry-writes.js';
import { onHandle, openStore, storeFilesOf } from './handles.js';
import { listRecallEntries } from './search-rows.js';
import * as vectorIndex from './vector-index.js';

export { initStore } from './handles.js';
export { upsertEntryRow } from './entry-row.js';
export { writeEntryDbOnly, type WriteEntryOptions } from './entry-writes.js';
export { buildIndexFromDb, writeIndexMirror } from './mirrors.js';
export { listVectorCandidateEntries } from './search-rows.js';
export { writeDeliveryEventOnHandle } from './recall-trace.js';
export { recordTokenUse, tokensBySession } from './token-ledger.js';

/** Write an entry to SQLite and refresh mirrors. `opts.actor` defaults to 'cli'. */
export function writeEntry(hippoRoot: string, entry: MemoryEntry, opts?: WriteEntryOptions): void {
  onHandle(
    hippoRoot,
    (db) => entryWrites.writeEntryOn(db, storeFilesOf(hippoRoot), entry, opts),
    openStore,
  );
}

/** Every tenant's entries, oldest first: an eval reads the whole folder it seeded. */
export function loadAllEntries(hippoRoot: string): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => [...entryReads.iterateEveryTenantEntries(db)], openStore);
}

/** The row with `id` in any tenant, or null: an eval reads back what it wrote, as loadAllEntries does. */
export function readEntryInFolder(hippoRoot: string, id: string): MemoryEntry | null {
  return onHandle(hippoRoot, (db) => entryReads.readEntry(db, id, ALL_TENANTS), openStore);
}

/** Every stored vector keyed by memory id; `{}` when none. */
export function loadEmbeddingIndex(hippoRoot: string): Record<string, number[]> {
  return onHandle(hippoRoot, (db) => vectorIndex.listAllVectors(db));
}

/** The eval kit's positional `loadRecallSearchEntries` serves the frozen q3b-ranker-floor benchmark through this. */
export function listRecallEntriesInFolder(
  hippoRoot: string,
  query: string,
  options: RecallSearchEntriesOptions,
): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => listRecallEntries(db, query, options), openStore);
}

/** The per-prompt tally, timed by scripts/check-request-path-timing.mjs on a folder it seeds. */
export function countAmbientInFolder(
  hippoRoot: string,
  tenantId: string,
  filter: AmbientStoreFilter,
): AmbientTallies {
  return onHandle(
    hippoRoot,
    (db) => ambient.countAmbient(db, storeFilesOf(hippoRoot), tenantId, filter),
    openStore,
  );
}

/** `batchWriteAndDelete` on a handle of its own; an empty batch opens no store. */
export function batchWriteAndDeleteInFolder(
  hippoRoot: string,
  toWrite: MemoryEntry[],
  toDeleteIds: string[],
  opts?: { snapshot?: ReadonlyMap<string, MemoryEntry>; dormant?: DormantMove[] },
): string[] {
  if (toWrite.length === 0 && toDeleteIds.length === 0 && (opts?.dormant ?? []).length === 0)
    return [];
  return onHandle(
    hippoRoot,
    (db) => batches.batchWriteAndDelete(db, storeFilesOf(hippoRoot), toWrite, toDeleteIds, opts),
    openStore,
  );
}
