// Test seams for add-ons and hippo's own suite. Not for production code; no semver guarantee beyond the major version.
import { fromWire, toWire, type MemoryWire } from '../core/memory-wire.js';
import type { openHippoDb } from '../db/index.js';
import { upsertEntryRow } from '../store/sqlite/entry-row.js';
import type { WriteEntryOptions } from '../store/sqlite/entry-writes.js';
import { batchWriteAndDelete, loadAllEntries, writeEntry } from '../store/sqlite/folder-forms.js';
export { _resetAblationCacheForTests } from '../core/ablation.js';
export { _setDigestExistsProbeForTests } from '../capture/session-digest.js';
export { _resetSharedStoreCacheForTests } from '../core/config.js';
export { _resetLossAversionRatioCacheForTests } from '../core/memory.js';
export { _resetProjectIdentityCacheForTests } from '../core/project-identity.js';
export { _resetSessionRecallHistoryMcpForTests } from '../mcp/session-state.js';
export { __resetSessionRecallHistoryHttp } from '../server/routes/recall.js';
export { _readApiKeyVerifyStatsForTests } from '../server/api-key.js';
export { _resetLogOnceForTests } from '../util/log.js';
// The eval kit: an eval seeds a store folder and reads it back whole, every tenant's rows included.
export { ambientSecretAdmit } from '../core/read-admission.js';
export { initStore } from '../store/sqlite/handles.js';
export { loadAllEntries, loadEmbeddingIndex, writeEntry } from '../store/sqlite/folder-forms.js';
export type { WriteEntryOptions } from '../store/sqlite/entry-writes.js';
export { embedMemory, loadRecallSearchEntries } from './folder-search.js';
// Frozen eval scripts read and write the snake_case keys; a re-pointed import line takes these forms.
export type { MemoryWire } from '../core/memory-wire.js';
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
export { resolveTenantId } from '../server/boot.js';
export { upsertEntryRow } from '../store/sqlite/entry-row.js';
export { writeEntryDbOnly } from '../store/sqlite/entry-writes.js';
export { buildIndexFromDb, writeIndexMirror } from '../store/sqlite/mirrors.js';
export { loadVectorCandidateEntriesAt } from '../store/sqlite/search-rows.js';
export { writeDeliveryEventOnHandle } from '../store/sqlite/recall-trace.js';
export { recordTokenUse, tokensBySession } from '../store/sqlite/token-ledger.js';

// The wire forms that read or write hippo.db live here, at the root, so wire-kit.ts stays off the SQLite adapter.
export function loadAllEntriesWire(hippoRoot: string): MemoryWire[] {
  return loadAllEntries(hippoRoot).map(toWire);
}

export function writeEntryWire(hippoRoot: string, entry: MemoryWire, opts?: WriteEntryOptions): void {
  writeEntry(hippoRoot, fromWire(entry), opts);
}

export function upsertEntryRowWire(db: ReturnType<typeof openHippoDb>, entry: MemoryWire): void {
  upsertEntryRow(db, fromWire(entry));
}

export function batchWriteAndDeleteWire(hippoRoot: string, toWrite: MemoryWire[], toDeleteIds: string[]): string[] {
  return batchWriteAndDelete(hippoRoot, toWrite.map(fromWire), toDeleteIds);
}
