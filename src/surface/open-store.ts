// The one module outside the SQLite adapter that names it: each composition root opens the default store, its request
// sessions, its store runtime and its server runtime here, so a second adapter changes this file and no root
// (scripts/check-layers.mjs). The exit hooks live here too, since the store layers install none.
import type { StoreRules } from '../base/ports/infra.js';
import type { HippoStore, StoreGroups } from '../base/ports/store-index.js';
import {
  sqliteServerRuntime,
  sqliteStore as sqliteStoreWith,
  StoreRuntime,
  type ServerRuntimeOptions,
  type SqliteServerRuntime,
} from '../store/sqlite/index.js';

export {
  askingNearestFirst,
  inSqliteSession as inStoreSession,
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
  type RequestStores as StoreSession,
  type ResolveOptions,
  type ServerRuntimeOptions,
  type SqliteServerRuntime as ServerRuntime,
  type SqliteStoreOptions as StoreOptions,
  type StoreRuntime,
} from '../store/sqlite/index.js';
// The published entries' own names: ./store-kit's default store and vector rules.
export {
  decodeVector,
  EMBEDDING_MODEL_META_KEY,
  encodeVector,
  OTHER_STORE_MARKER,
  rankVectorRows,
  type VectorMatch,
  type VectorRow,
} from '../store/sqlite/index.js';

/** ./store-kit's default store takes only the rules an add-on picks: a runtime or a session belongs to a composition
 * root, and the published entries export neither. */
export const sqliteStore: (hippoRoot: string, rules?: StoreRules) => HippoStore & StoreGroups = sqliteStoreWith;

/** A store runtime for a root that runs until the process exits, such as the CLI or the stdio MCP loop; its exit hook
 * disposes it. */
export function openRootStoreRuntime(): StoreRuntime {
  const runtime = new StoreRuntime();
  process.once('exit', () => runtime.dispose());
  return runtime;
}

/** hippo.db as a server serves it, with an exit hook that closes what the server opened if close() never runs. */
export function defaultServerRuntime(hippoRoot: string, opts: ServerRuntimeOptions = {}): SqliteServerRuntime {
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
