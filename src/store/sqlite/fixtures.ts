// The ./testing entry's hippo.db seams, its one door into the adapter: evals seed and read a store folder, and
// benchmarks a handle they open themselves.
export { initStore } from './handles.js';
export { batchWriteAndDelete, loadAllEntries, loadEmbeddingIndex, writeEntry } from './folder-forms.js';
export { upsertEntryRow } from './entry-row.js';
export { writeEntryDbOnly, type WriteEntryOptions } from './entry-writes.js';
export { buildIndexFromDb, writeIndexMirror } from './mirrors.js';
export { loadVectorCandidateEntriesAt } from './search-rows.js';
export { writeDeliveryEventOnHandle } from './recall-trace.js';
export { recordTokenUse, tokensBySession } from './token-ledger.js';
export type { openHippoDb } from '../../db/index.js';
