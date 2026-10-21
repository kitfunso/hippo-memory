// The one module outside the SQLite adapter that names it: each composition root opens the default store, its request
// scopes and its server runtime here, so a second adapter changes this file and no root (scripts/check-layers.mjs).
export {
  askingNearestFirst,
  runDetachedSqliteRequest as runDetachedStoreRequest,
  runSqliteBatch as runStoreBatch,
  runSqliteHookRequest as runStoreHookRequest,
  runSqliteRequest as runStoreRequest,
  sqliteDashboardReads as defaultDashboardReads,
  sqliteDiagnosticsStore as defaultDiagnostics,
  sqliteImportFiles as defaultImportFiles,
  sqliteImportStores as defaultImportStores,
  sqliteReach as defaultReach,
  sqliteServerRuntime as defaultServerRuntime,
  sqliteStore as defaultStore,
  tenantOfApiKey,
  withSharedStoreHandles,
  type ResolveOptions,
  type ServerRuntimeOptions,
  type SqliteServerRuntime as ServerRuntime,
} from '../store/sqlite/index.js';
// The published entries' own names: ./store-kit's default store and vector rules, and ./testing's hippo.db seams.
export {
  decodeVector,
  EMBEDDING_MODEL_META_KEY,
  encodeVector,
  OTHER_STORE_MARKER,
  rankVectorRows,
  sqliteStore,
  type VectorMatch,
  type VectorRow,
} from '../store/sqlite/index.js';
export {
  batchWriteAndDelete,
  buildIndexFromDb,
  initStore,
  loadAllEntries,
  loadEmbeddingIndex,
  loadRecallSearchEntries,
  loadVectorCandidateEntriesAt,
  recordTokenUse,
  tokensBySession,
  upsertEntryRow,
  writeDeliveryEventOnHandle,
  writeEntry,
  writeEntryDbOnly,
  writeIndexMirror,
  type WriteEntryOptions,
} from '../store/sqlite/fixtures.js';
