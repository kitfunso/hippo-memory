// Test seams for add-ons and hippo's own suite. Not for production code; no semver guarantee beyond the major version.
import { fromWire, toWire, type MemoryWire } from '../base/memory/memory-wire.js';
import {
  batchWriteAndDelete,
  loadAllEntries,
  upsertEntryRow,
  writeEntry,
  type WriteEntryOptions,
} from '../surface/testing-kit.js';
// The eval kit: an eval seeds a store folder and reads it back whole, every tenant's rows included.
export { ambientSecretAdmit } from '../base/scope/read-admission.js';
export { initStore, loadAllEntries, loadEmbeddingIndex, writeEntry } from '../surface/testing-kit.js';
export type { WriteEntryOptions } from '../surface/testing-kit.js';
export { embedMemory, loadRecallSearchEntries } from './folder-search.js';
// A second adapter of every required store group, held in memory, so an add-on's tests can run without a folder.
export { memoryStore } from '../store/memory/store.js';
export type { MemoryTables } from '../store/memory/tables.js';
// Frozen eval scripts read and write the snake_case keys; a re-pointed import line takes these forms.
export type { MemoryWire } from '../base/memory/memory-wire.js';
export {
  ambientSecretAdmitWire,
  calculateStrengthWire,
  createMemoryWire,
  embedMemoryWire,
  hybridSearchWire,
  isWorthSurfacingWire,
  type WireSearchResult,
  type WireStrengthInputs,
} from './wire-kit.js';
// Benchmarks and token evals seed and read hippo.db on a handle they open themselves.
export { resolveTenantId } from '../surface/server/boot.js';
export {
  buildIndexFromDb,
  loadVectorCandidateEntries as loadVectorCandidateEntriesAt,
  recordTokenUse,
  tokensBySession,
  upsertEntryRow,
  writeDeliveryEventOnHandle,
  writeEntryDbOnly,
  writeIndexMirror,
} from '../surface/testing-kit.js';

// The wire forms that read or write hippo.db live here, at the root, so wire-kit.ts stays off the hippo.db adapter.
export function loadAllEntriesWire(hippoRoot: string): MemoryWire[] {
  return loadAllEntries(hippoRoot).map(toWire);
}

export function writeEntryWire(hippoRoot: string, entry: MemoryWire, opts?: WriteEntryOptions): void {
  writeEntry(hippoRoot, fromWire(entry), opts);
}

export function upsertEntryRowWire(db: Parameters<typeof upsertEntryRow>[0], entry: MemoryWire): void {
  upsertEntryRow(db, fromWire(entry));
}

export function batchWriteAndDeleteWire(hippoRoot: string, toWrite: MemoryWire[], toDeleteIds: string[]): string[] {
  return batchWriteAndDelete(hippoRoot, toWrite.map(fromWire), toDeleteIds);
}
