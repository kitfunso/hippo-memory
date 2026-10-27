// The SQLite adapter's door: a composition root takes hippo.db's store, reach, dashboard reads,
// request sessions and server runtime from these names alone, so the modules behind them and src/db
// change without a root noticing (.dependency-cruiser.cjs).
export { inSqliteSession, sqliteDiagnosticsStore, sqliteReach, sqliteStore } from './store.js';
export { sqliteDashboardReads } from './dashboard-reads.js';
export { sqliteImportFiles } from './import-files.js';
export { sqliteImportStores } from './agent-import-stores.js';
export {
  openSqliteSession,
  runSqliteBatch,
  runSqliteHookRequest,
  runSqliteRequest,
  type RequestPreset,
} from './request-scope.js';
export {
  sqliteServerRuntime,
  type ServerRuntimeOptions,
  type SqliteServerRuntime,
} from './server-runtime.js';
export type { SqliteStoreOptions } from './grant.js';
export { StoreRuntime } from '../../db/store-runtime.js';
export { setDefaultBusyWaitMs } from '../../db/busy.js';
export type { RequestStores } from '../../db/index.js';
export { tenantOfApiKey, type ResolveOptions } from './tenant.js';
export { askingNearestFirst } from './vector-reads.js';
export { saveVectorGraphFile } from './vector-graph-file.js';
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
