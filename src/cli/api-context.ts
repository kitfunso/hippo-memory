import { adminActor } from '../api/index.js';
import { contextReach, type ContextReach, type ContextWith, type GlobalInReach } from '../api/types.js';
import type { ConfiguredFolder } from '../search/embed-memories.js';
import type { Machine, SyncOptions } from '../agent-memories/sync.js';
import { ledgerReachOf, type LedgerReach } from '../api/ledger-db.js';
import { configReader, type ConfigReader } from '../core/config.js';
import { runConsolidation } from '../consolidate/sleep.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import type { McpHost } from '../mcp/protocol.js';
import type { HippoStore, StoreGroups } from '../store/index.js';
import type { LocalFiles, OptionalGroup } from '../store/port.js';
import {
  runDetachedSqliteRequest, runSqliteHookRequest, runSqliteRequest, sqliteReach, sqliteStore, sqliteSyncStore,
} from '../store/sqlite/store.js';
import { CLI_ACTOR } from '../core/actor.js';

/** The CLI process's config reader: the stdio MCP server lives as long as its host, so each call parses an
 * unchanged config.json once. */
export const cliConfig: ConfigReader = configReader();

/** The store the CLI and the stdio MCP server open; the adapter is named here so src/mcp never imports it. */
export function cliStore(hippoRoot: string): HippoStore & StoreGroups {
  return sqliteStore(hippoRoot);
}

/** A folder's hippo.db beside its folder, as sharing and sync take each side; the global one may not exist yet. */
export function cliFolder(hippoRoot: string): ConfiguredFolder {
  return { root: hippoRoot, store: cliStore(hippoRoot), config: cliConfig(hippoRoot) };
}

/** hippo.db whose calls answer at once, for a hook or verb that counts each statement against its own time. */
export function cliSyncStore(hippoRoot: string): ReturnType<typeof sqliteSyncStore> {
  return sqliteSyncStore(hippoRoot);
}

/** The folder's hippo.db for a verb that runs a sleep pass by itself. */
export function cliLocalFiles(hippoRoot: string): LocalFiles {
  return cliSyncStore(hippoRoot).localFiles;
}

/** Creates the global store, or finishes one that was partly made: what a first share needs of it. */
export function cliInitGlobal(): void {
  cliLocalFiles(getGlobalRoot()).ensureFiles();
}

/** One handle per store at the hook's lock wait; a store still busy after it skips the hook's work and answers
 * undefined. */
export function cliHookRequest<T>(run: () => T | Promise<T>): Promise<T | undefined> {
  return runSqliteHookRequest(run);
}

/** A CLI verb's agent-memory import options: each target reads its own config.json and opens through the SQLite
 * adapter. */
export function cliSyncOptions(
  hippoRoot: string, machine: Machine, extra: Pick<SyncOptions, 'dryRun' | 'busyWaitMs'> = {},
): SyncOptions {
  return { configAt: cliConfig, machine, agentImport: cliLocalFiles(hippoRoot).agentImport, ...extra };
}

/** The request scope a scoped CLI verb and the stdio MCP server run in; named here so no other surface opens one. */
export function cliRequest<T>(run: () => T | Promise<T>): Promise<T> {
  return runSqliteRequest(run, 'cli');
}

/** The CLI's store is hippo.db, which sets every optional group, so its verbs call the api unchecked. */
export type CliContext = ContextWith<OptionalGroup>;

/** The stores a CLI call on `hippoRoot` reaches, each global one with its config. */
function cliReach(hippoRoot: string, store: HippoStore): ContextReach {
  return contextReach(sqliteReach(hippoRoot, store), cliConfig);
}

// The one place the CLI names its audit actor and builds its store;
// root is a parameter because some verbs target the global store.
export function cliApiContext(hippoRoot: string, tenantId: string): CliContext {
  const store = cliStore(hippoRoot);
  // Read here, once per command, so a long-lived caller of this function never pins a stale config.
  const config = cliConfig(hippoRoot);
  return { hippoRoot, tenantId, actor: adminActor(CLI_ACTOR), store, reach: cliReach(hippoRoot, store), config };
}

/** A second store a CLI read searches beside its own, with that store's config. */
export function cliSecondStore(root: string): GlobalInReach {
  return { root, store: cliStore(root), config: cliConfig(root) };
}

/** Where a hook on `hippoRoot` books its ledger rows: the folder's store, else the global one, probed once here. */
export function cliLedgerReach(hippoRoot: string): LedgerReach {
  const store = cliStore(hippoRoot);
  return ledgerReachOf({ hippoRoot, reach: cliReach(hippoRoot, store), store, config: cliConfig(hippoRoot) });
}

/** Stdio is the operator's own process: host admin, the folder's hippo.db, and an auto-sleep that runs in process. */
export const cliStdioHost: McpHost = {
  contextFor(hippoRoot, tenantId) {
    const store = cliStore(hippoRoot);
    return {
      hippoRoot,
      tenantId,
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      stdio: true,
      store,
      config: cliConfig(hippoRoot),
      reach: cliReach(hippoRoot, store),
      autoSleepRunner: (root) =>
        runDetachedSqliteRequest(() => runConsolidation(cliLocalFiles(root), { config: cliConfig(root) }))
          .then(() => {}),
    };
  },
  runRequest: cliRequest,
};
