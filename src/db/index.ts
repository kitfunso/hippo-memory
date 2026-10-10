// Public face of the database layer; the code lives in src/db/ and each schema migration in src/db/migrations/.
export type { DatabaseSyncLike } from './sqlite.js';
export {
  isSqliteBusy,
  isStoreBusy,
  StoreBusyError,
  STORE_BUSY_MESSAGE,
  execWithBusyRetry,
  withReadSnapshot,
  withTrialScope,
  withWriteScope,
  withWriteScopeOr
} from './busy.js';
export { getSchemaVersion, getMeta, setMeta, isFtsAvailable } from './meta.js';
export { countTableRows, pruneConsolidationRuns, CONSOLIDATION_RUNS_KEPT } from './tables.js';
export { getCurrentSchemaVersion, IncompatibleBinaryError, ftsRowCounts, repairFtsDrift } from './migrate.js';
export {
  getHippoDbPath,
  HOOK_DB_WAIT_MS,
  noteStoreBusy,
  withSharedStoreHandles,
  SERVER_DB_WAIT_MS,
  SLEEP_DB_WAIT_MS,
  scopedBusyWait,
  withSqliteBlocked,
  withSqliteAllowed,
  withSqliteOffLoop,
  outsideSqliteOffLoop,
  rethrowIfSqliteBlocked,
  OTHER_STORE_MARKER,
  openHippoDb,
  openHippoDbReadOnly,
  closeHippoDb,
} from './open.js';
export { RequestStores, runWithRequestStores, currentRequestStores, outsideRequestStores } from './request-stores.js';
export { OtherStoreFolderError, SqliteBlockedError } from '../util/sqlite-blocked.js';
