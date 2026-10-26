// Public face of the database layer; the code lives in src/db/ and each schema migration in
// src/db/migrations/.
export type { DatabaseSyncLike, SqlResult, SqlValue } from './sqlite.js';
export {
  execWithBusyRetry,
  isSqliteBusy,
  withReadSnapshot,
  withTrialScope,
  withWriteScope,
  withWriteScopeOr,
} from './busy.js';
export { getSchemaVersion, getMeta, setMeta, isFtsAvailable } from './meta.js';
export { countTableRows, pruneConsolidationRuns, CONSOLIDATION_RUNS_KEPT } from './tables.js';
export {
  getCurrentSchemaVersion,
  IncompatibleBinaryError,
  ftsRowCounts,
  isFtsInSync,
  repairFtsDrift,
  setFtsInSync,
} from './migrate.js';
export {
  getHippoDbPath,
  HOOK_DB_WAIT_MS,
  noteStoreBusy,
  SERVER_DB_WAIT_MS,
  SLEEP_DB_WAIT_MS,
  OTHER_STORE_MARKER,
  openHippoDb,
  openHippoDbReadOnly,
  closeHippoDb,
} from './open.js';
export type { DbGrant, OpenOptions } from './grant.js';
export {
  RequestStores,
  sessionOf,
  withSharedStoreHandles,
  withSharedStoreHandlesSync,
  type RequestStoresOptions,
} from './request-stores.js';
export { OtherStoreFolderError, SqliteBlockedError } from './sqlite-blocked.js';
