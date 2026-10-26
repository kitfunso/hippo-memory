// The one module outside the SQLite adapter that names it: each composition root opens the default store, its request
// scopes, its store runtime and its server runtime here, so a second adapter changes this file and no root
// (scripts/check-layers.mjs). The exit hooks live here too, since the store layers install none.
import {
  currentStoreRuntime,
  sqliteServerRuntime,
  StoreRuntime,
  type ServerRuntimeOptions,
  type SqliteServerRuntime,
} from '../store/sqlite/index.js';

export {
  askingNearestFirst,
  runDetachedSqliteRequest as runDetachedStoreRequest,
  runSqliteBatch as runStoreBatch,
  runSqliteHookRequest as runStoreHookRequest,
  runSqliteRequest as runStoreRequest,
  saveVectorGraphFile,
  sqliteDashboardReads as defaultDashboardReads,
  sqliteDiagnosticsStore as defaultDiagnostics,
  sqliteImportFiles as defaultImportFiles,
  sqliteImportStores as defaultImportStores,
  sqliteReach as defaultReach,
  sqliteStore as defaultStore,
  tenantOfApiKey,
  withSharedStoreHandles,
  type ResolveOptions,
  type ServerRuntimeOptions,
  type SqliteServerRuntime as ServerRuntime,
} from '../store/sqlite/index.js';
// The published entries' own names: ./store-kit's default store and vector rules.
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

/** Runs `fn` inside the process's store runtime: inside one already, it joins it; else it opens one that is disposed
 * when `fn` settles, or by its exit hook when process.exit comes first. */
export async function withRootStoreRuntime<T>(fn: () => Promise<T>): Promise<T> {
  if (currentStoreRuntime()) return fn();
  const runtime = new StoreRuntime();
  const onExit = (): void => runtime.dispose();
  process.once('exit', onExit);
  try {
    return await runtime.run(fn);
  } finally {
    process.off('exit', onExit);
    runtime.dispose();
  }
}

/** A store runtime for a root that runs until the process exits, such as the stdio MCP loop; its exit hook disposes
 * it. */
export function openRootStoreRuntime(): StoreRuntime {
  const runtime = new StoreRuntime();
  process.once('exit', () => runtime.dispose());
  return runtime;
}

/** hippo.db as a server serves it, with an exit hook that closes what the server opened if close() never runs. */
export function defaultServerRuntime(
  hippoRoot: string,
  opts: ServerRuntimeOptions = {},
): SqliteServerRuntime {
  const runtime = sqliteServerRuntime(hippoRoot, opts);
  const onExit = (): void => runtime.closeOnExit();
  process.once('exit', onExit);
  return {
    ...runtime,
    close: async () => {
      process.off('exit', onExit);
      await runtime.close();
    },
  };
}
