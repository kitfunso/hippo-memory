// The one module outside the SQLite adapter that imports it (.dependency-cruiser.cjs): a composition
// root opens hippo.db, its sessions and runtimes through the adapter's functions under their own
// names. The exit hooks live here too, since the store layers install none.
import {
  sqliteServerRuntime,
  StoreRuntime,
  type ServerRuntimeOptions,
  type SqliteServerRuntime,
} from '../store/sqlite/index.js';

export {
  askingNearestFirst,
  inSqliteSession,
  runSqliteBatch,
  runSqliteHookRequest,
  runSqliteRequest,
  saveVectorGraphFile,
  sqliteDashboardReads,
  sqliteDiagnosticsStore,
  sqliteImportFiles,
  sqliteImportStores,
  sqliteReach,
  sqliteStore,
  tenantOfApiKey,
  withSharedStoreHandles,
  type RequestStores,
  type ResolveOptions,
  type ServerRuntimeOptions,
  type SqliteServerRuntime,
  type SqliteStoreOptions,
  type StoreRuntime,
} from '../store/sqlite/index.js';
// The vector rules ./store-kit publishes under the names they have here.
export {
  decodeVector,
  EMBEDDING_MODEL_META_KEY,
  encodeVector,
  OTHER_STORE_MARKER,
  rankVectorRows,
  type VectorMatch,
  type VectorRow,
} from '../store/sqlite/index.js';

/** Runs `fn` on a store runtime of its own, disposed with the work `fn` detached on it once `fn`
 * settles, or closed by its exit hook if the process exits first. */
export async function withStoreRuntime<T>(fn: (runtime: StoreRuntime) => Promise<T>): Promise<T> {
  const runtime = new StoreRuntime();
  const onExit = (): void => runtime.closeNow();
  process.once('exit', onExit);
  try {
    return await fn(runtime);
  } finally {
    try {
      await runtime.dispose();
    } finally {
      process.off('exit', onExit);
    }
  }
}

/** hippo.db as a server serves it, with an exit hook that closes what the server opened if
 * close() never runs. */
export function sqliteServerRuntimeWithExitHook(
  hippoRoot: string,
  opts: ServerRuntimeOptions = {},
): SqliteServerRuntime {
  const runtime = sqliteServerRuntime(hippoRoot, opts);
  const onExit = (): void => runtime.closeOnExit();
  process.once('exit', onExit);
  return {
    ...runtime,
    close: async (settleWithinMs) => {
      process.off('exit', onExit);
      await runtime.close(settleWithinMs);
    },
  };
}
