// Public face of the database layer; the code lives in src/db/ and each schema migration in src/db/migrations/.
export type { DatabaseSyncLike } from './db/sqlite.js';
export { isSqliteBusy, isStoreBusy, StoreBusyError, STORE_BUSY_MESSAGE, execWithBusyRetry, withWriteScope } from './db/busy.js';
export { getSchemaVersion, getMeta, setMeta, isFtsAvailable } from './db/meta.js';
export { countTableRows, pruneConsolidationRuns } from './db/tables.js';
export { getCurrentSchemaVersion, IncompatibleBinaryError, ftsRowCounts, repairFtsDrift } from './db/migrate.js';
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
  rethrowIfSqliteBlocked,
  OTHER_STORE_MARKER,
  openHippoDb,
  openHippoDbReadOnly,
  closeHippoDb,
} from './db/open.js';
export { RequestStores, runWithRequestStores, currentRequestStores, outsideRequestStores } from './db/request-stores.js';
export { OtherStoreFolderError, SqliteBlockedError } from './db/sqlite-blocked.js';
