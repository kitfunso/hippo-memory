// The ./testing entry's hippo.db seams, the one door into the adapter besides the composition root: evals seed and read
// a store folder, and benchmarks a handle they open themselves. Production code takes its store from open-store.ts.
export {
  batchWriteAndDelete,
  buildIndexFromDb,
  initStore,
  loadAllEntries,
  loadEmbeddingIndex,
  loadRecallSearchEntries,
  loadVectorCandidateEntries,
  recordTokenUse,
  tokensBySession,
  upsertEntryRow,
  writeDeliveryEventOnHandle,
  writeEntry,
  writeEntryDbOnly,
  writeIndexMirror,
  type WriteEntryOptions,
} from '../store/sqlite/fixtures.js';
