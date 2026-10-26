// The SQLite adapter's door: a composition root takes hippo.db's store, reach, dashboard reads, request scopes and
// server runtime from these names alone, so the modules behind them and src/db change without a root noticing
// (scripts/checks/check-layers.mjs).
export { sqliteDiagnosticsStore, sqliteReach, sqliteStore } from './store.js';
export { sqliteDashboardReads } from './reports/dashboard-reads.js';
export { sqliteImportFiles } from './maintenance/import-files.js';
export { sqliteImportStores } from './maintenance/agent-import-stores.js';
export {
  runDetachedSqliteRequest,
  runSqliteBatch,
  runSqliteHookRequest,
  runSqliteRequest,
} from './runtime/request-scope.js';
export { sqliteServerRuntime, type ServerRuntimeOptions, type SqliteServerRuntime } from './runtime/server-runtime.js';
export { currentStoreRuntime, StoreRuntime } from '../../db/store-runtime.js';
export { tenantOfApiKey, type ResolveOptions } from './runtime/tenant.js';
export { askingNearestFirst } from './vectors/vector-reads.js';
export { saveVectorGraphFile } from '../../db/vector-graph-build.js';
export { OTHER_STORE_MARKER, withSharedStoreHandles } from '../../db/index.js';
// The ./store-kit entry's vector rules, so an add-on store keeps hippo.db's bytes and ranking.
export {
  decodeVector,
  EMBEDDING_MODEL_META_KEY,
  encodeVector,
  rankVectorRows,
  type VectorMatch,
  type VectorRow,
} from '../../db/vector-store.js';
