// The ./testing entry's hippo.db seams, its one door into the adapter: evals seed and read a store
// folder, and benchmarks a handle they open themselves. The kit is synchronous and the port is not,
// so each seam runs on a handle.
import type { AmbientTallies } from '../../base/memory/ambient.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type { DormantMove } from '../../base/records/consolidation.js';
import type { AmbientStoreFilter } from '../../base/ports/store/context-reads.js';
import type { RecallSearchEntriesOptions } from '../../base/records/sharing.js';
import * as ambient from './recall/ambient.js';
import { batchWriteAndDelete } from './entries/batch-flush.js';
import * as entryReads from './entries/entry-reads.js';
import * as entryWrites from './entries/entry-writes.js';
import type { WriteEntryOptions } from './entries/entry-writes.js';
import { onHandle, openStore, storeFilesOf } from './runtime/handles.js';
import { readWrite, type StoreFiles } from './runtime/open.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import { listRecallEntries } from './recall/search-rows.js';
import * as vectorIndex from './vectors/vector-index.js';

export { initStore } from './runtime/handles.js';
export { upsertEntryRow } from './entries/entry-row.js';
export { writeEntryDbOnly, type WriteEntryOptions } from './entries/entry-writes.js';
export { buildIndexFromDb, writeIndexMirror } from './folder-files/mirrors.js';
export { listVectorCandidateEntries } from './recall/search-rows.js';
export { writeDeliveryEventOnHandle } from './ledger/delivery-ledger.js';
export { recordTokenUse, tokensBySession } from './ledger/token-ledger.js';

/** Write an entry to SQLite and refresh mirrors. `opts.actor` defaults to 'cli'. */
export function writeEntry(hippoRoot: string, entry: MemoryEntry, opts?: WriteEntryOptions): void {
  writeEntryIn(storeFilesOf(hippoRoot), entry, opts);
}

/** Every tenant's entries, oldest first: an eval reads the whole folder it seeded. */
export function loadAllEntries(hippoRoot: string): MemoryEntry[] {
  return loadAllEntriesIn(storeFilesOf(hippoRoot));
}

/** The row with `id` in any tenant, or null: an eval reads back what it wrote, as
 * loadAllEntries does. */
export function readEntryInFolder(hippoRoot: string, id: string): MemoryEntry | null {
  return readEntryIn(storeFilesOf(hippoRoot), id);
}

// The forms on `files`: an eval that builds them with a session runs its calls on one handle
// per store.
const openOn =
  (files: StoreFiles) =>
  (hippoRoot: string): DatabaseSyncLike =>
    openStore(hippoRoot, files.opens);

export function writeEntryIn(
  files: StoreFiles,
  entry: MemoryEntry,
  opts?: WriteEntryOptions,
): void {
  onHandle(
    files.hippoRoot,
    (db) => entryWrites.writeEntryInOwnTx(db, files, entry, opts),
    openOn(files),
  );
}

export function loadAllEntriesIn(files: StoreFiles): MemoryEntry[] {
  return onHandle(
    files.hippoRoot,
    (db) => [...entryReads.iterateEveryTenantEntries(db)],
    openOn(files),
  );
}

export function readEntryIn(files: StoreFiles, id: string): MemoryEntry | null {
  return onHandle(
    files.hippoRoot,
    (db) => entryReads.readEntry(db, id, ALL_TENANTS),
    openOn(files),
  );
}

/** Every stored vector keyed by memory id; `{}` when none. */
export function loadEmbeddingIndex(hippoRoot: string): Record<string, number[]> {
  const files = storeFilesOf(hippoRoot);
  return onHandle(
    hippoRoot,
    (db) => vectorIndex.listAllVectors(db),
    (root) => readWrite(root, files.opens),
  );
}

/** The eval kit's positional `loadRecallSearchEntries` serves the frozen q3b-ranker-floor
 * benchmark through this. */
export function listRecallEntriesInFolder(
  hippoRoot: string,
  query: string,
  options: RecallSearchEntriesOptions,
): MemoryEntry[] {
  return onHandle(
    hippoRoot,
    (db) => listRecallEntries(db, query, options),
    openOn(storeFilesOf(hippoRoot)),
  );
}

/** The per-prompt tally, timed by scripts/checks/check-request-path-timing.mjs on a folder it seeds. */
export function countAmbientInFolder(
  hippoRoot: string,
  tenantId: string,
  filter: AmbientStoreFilter,
): AmbientTallies {
  const files = storeFilesOf(hippoRoot);
  return onHandle(
    hippoRoot,
    (db) => ambient.countAmbient(db, files, tenantId, filter),
    openOn(files),
  );
}

/** `batchWriteAndDelete` on a handle of its own; an empty batch opens no store. */
export function batchWriteAndDeleteInFolder(
  hippoRoot: string,
  toWrite: MemoryEntry[],
  toDeleteIds: string[],
  opts?: { snapshot?: ReadonlyMap<string, MemoryEntry>; dormant?: DormantMove[] },
): string[] {
  if (toWrite.length === 0 && toDeleteIds.length === 0 && (opts?.dormant ?? []).length === 0) {
    return [];
  }
  const files = storeFilesOf(hippoRoot);
  return onHandle(
    hippoRoot,
    (db) => batchWriteAndDelete(db, { files, toWrite, toDeleteIds, opts }),
    openOn(files),
  );
}
