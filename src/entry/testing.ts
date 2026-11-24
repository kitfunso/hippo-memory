import { fromWire, toWire, type MemoryWire } from '../base/memory/memory-wire.js';
import {
  batchWriteAndDeleteInFolder,
  loadAllEntries,
  upsertEntryRow,
  writeEntry,
  type WriteEntryOptions,
} from '../surface/testing-kit.js';
export { ambientSecretAdmit } from '../base/scope/read-admission.js';
export {
  initStore,
  loadAllEntries,
  loadEmbeddingIndex,
  writeEntry,
} from '../surface/testing-kit.js';
export type { WriteEntryOptions } from '../surface/testing-kit.js';
export { embedMemory, loadRecallSearchEntries } from './folder-search.js';
export { saveCustomerNote, saveDecision, savePolicy, saveProjectBrief } from './object-saves.js';
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
export { resolveTenantId } from '../surface/server/boot.js';
export {
  buildIndexFromDb,
  listVectorCandidateEntries as loadVectorCandidateEntriesAt,
  recordTokenUse,
  tokensBySession,
  upsertEntryRow,
  writeDeliveryEventOnHandle,
  writeEntryDbOnly,
  writeIndexMirror,
} from '../surface/testing-kit.js';

export function loadAllEntriesWire(hippoRoot: string): MemoryWire[] {
  return loadAllEntries(hippoRoot).map(toWire);
}

export function writeEntryWire(
  hippoRoot: string,
  entry: MemoryWire,
  opts?: WriteEntryOptions,
): void {
  writeEntry(hippoRoot, fromWire(entry), opts);
}

export function upsertEntryRowWire(
  db: Parameters<typeof upsertEntryRow>[0],
  entry: MemoryWire,
): void {
  upsertEntryRow(db, fromWire(entry));
}

export function batchWriteAndDeleteWire(
  hippoRoot: string,
  toWrite: MemoryWire[],
  toDeleteIds: string[],
): string[] {
  return batchWriteAndDeleteInFolder(hippoRoot, toWrite.map(fromWire), toDeleteIds);
}
