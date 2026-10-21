import { adminActor } from '../../api/index.js';
import { contextReach, type ContextReach, type ContextWith, type GlobalInReach } from '../../api/types.js';
import type { ConfiguredFolder } from '../../domain/search/embed-memories.js';
import type { SyncOptions } from '../../domain/agent-memories/sync.js';
import type { Machine } from '../../base/util/agent-homes.js';
import { ledgerReachOf, type LedgerReach } from '../../api/ledger-db.js';
import { configReader, type ConfigReader } from '../../base/config/config.js';
import { consolidateStore, logPhaseFailures } from '../../api/sleep/upkeep.js';
import { rerankerWithClef } from '../../api/recall/rows.js';
import { resolveGlobalRootDir } from '../../base/scope/project-identity.js';
import type { McpHost } from '../mcp/protocol.js';
import type { ImportFiles } from '../importers/core.js';
import type { HippoStore, StoreGroups } from '../../store/index.js';
import type { OptionalGroup } from '../../store/port.js';
import {
  askingNearestFirst,
  defaultDiagnostics,
  defaultImportFiles,
  defaultImportStores,
  defaultReach,
  defaultStore,
  runDetachedStoreRequest,
  runStoreBatch,
  runStoreHookRequest,
  runStoreRequest,
} from '../open-store.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import { envClefSettings, envLossAversionRatio, envRuntimeSettings, envTenant } from '../../base/util/env.js';
import type { RerankerFn } from '../../domain/rerankers/index.js';
import { autoSleepHost, createCallerState, type CallerState } from '../../api/callers.js';
import { anthropicLlmFromEnv } from '../../infra/ports.js';
import { resolveEmbeddingProvider } from '../../infra/embedding-provider.js';
import { serverNearestAsk } from './server-nearest.js';

/** The CLI process's config reader: the stdio MCP server lives as long as its host, so each call parses an unchanged
 * config.json once. */
export const cliConfig: ConfigReader = configReader(envRuntimeSettings);

/** A registry reranker with the CLEF transport this process's environment names, for a script that reranks outside a
 * recall. */
export function cliReranker(name: string | null | undefined): RerankerFn | null {
  return rerankerWithClef(name, envClefSettings());
}

/** The store the CLI and the stdio MCP server open; it is opened here so src/surface/mcp never names the adapter. A
 * `hippo serve` on the same store answers its nearest-row reads from the graph it holds. */
export function cliStore(hippoRoot: string): HippoStore & StoreGroups {
  const store = defaultStore(hippoRoot, { lossAversionRatio: envLossAversionRatio() });
  return askingNearestFirst(hippoRoot, store, serverNearestAsk(hippoRoot), cliConfig(hippoRoot).vectorGraph.maxVectors);
}

/** The folder's hippo.db as doctor reads it: read-only, so a check leaves the store as it found it. */
export function cliDiagnostics(hippoRoot: string): Pick<StoreGroups, 'diagnostics' | 'projectTags'> {
  return defaultDiagnostics(hippoRoot);
}

/** A folder's hippo.db with its config, as sharing and sync take each side; the global one may not exist yet. */
export function cliFolder(hippoRoot: string): ConfiguredFolder<HippoStore & StoreGroups> {
  return { store: cliStore(hippoRoot), config: cliConfig(hippoRoot), embedderFor: resolveEmbeddingProvider };
}

/** The folder's hippo.db as an import reaches it, answering at once: the published importers return their result. */
export function cliImportFiles(hippoRoot: string): ImportFiles {
  return defaultImportFiles(hippoRoot);
}

/** Creates the global store, or finishes one that was partly made: what a first share needs of it. */
export function cliInitGlobal(): void {
  cliImportFiles(resolveGlobalRootDir()).ensure();
}

/** One handle per store at the hook's lock wait; a store still busy after it skips the hook's work and answers
 * undefined. */
export function cliHookRequest<T>(run: () => T | Promise<T>): Promise<T | undefined> {
  return runStoreHookRequest(run);
}

/** A CLI verb's agent-memory import options: each target reads its own config.json and opens through the default
 * store, scored by this process's loss-aversion ratio as cliStore's stores are. */
export function cliSyncOptions(
  tenantId: string,
  machine: Machine,
  extra: Pick<SyncOptions, 'dryRun' | 'busyWaitMs'> = {},
): SyncOptions {
  const stores = defaultImportStores({ lossAversionRatio: envLossAversionRatio() });
  return { tenantId, configAt: cliConfig, machine, stores, ...extra };
}

/** The request scope a scoped CLI verb and the stdio MCP server run in; named here so no other surface opens one. */
export function cliRequest<T>(run: () => T | Promise<T>): Promise<T> {
  return runStoreRequest(run, 'cli');
}

/** One handle per store for a synchronous batch, such as an import's writes, that runs outside any request. */
export function cliBatch<T>(run: () => T): T {
  return runStoreBatch(run);
}

/** The CLI's store is hippo.db, which sets every optional group, so its verbs call the api
 * unchecked; the folder rides beside the api's Context for the verbs that reopen it. */
export type CliContext = ContextWith<OptionalGroup> & { readonly hippoRoot: string };

/** The stores a CLI call on `hippoRoot` reaches, each global one with its config. */
function cliReach(hippoRoot: string, store: HippoStore): ContextReach {
  return contextReach(defaultReach(hippoRoot, store, undefined, cliStore), cliConfig, resolveEmbeddingProvider);
}

// The one place the CLI names its audit actor and builds its store; root is a parameter because some verbs target the
// global store.
// A command's callers start empty unless its caller holds a set; a CLI write starts no sleep.
export function cliApiContext(
  hippoRoot: string,
  tenantId: string,
  callers: CallerState = createCallerState(),
): CliContext {
  const store = cliStore(hippoRoot);
  // Read here, once per command, so a long-lived caller of this function never pins a stale config.
  const config = cliConfig(hippoRoot);
  const reach = cliReach(hippoRoot, store);
  return { hippoRoot, tenantId, actor: adminActor(CLI_ACTOR), store, reach, config, callers };
}

/** A second store a CLI read searches beside its own, with that store's config. */
export function cliSecondStore(root: string): GlobalInReach {
  return { root, store: cliStore(root), config: cliConfig(root) };
}

/** Where a hook on `hippoRoot` books its ledger rows: the folder's store, else the global one, probed once here. */
export function cliLedgerReach(hippoRoot: string): LedgerReach {
  const store = cliStore(hippoRoot);
  return ledgerReachOf({ reach: cliReach(hippoRoot, store), store, config: cliConfig(hippoRoot) });
}

/** Stdio is the operator's own process: host admin, the folder's hippo.db, and an auto-sleep that runs in process. One
 * host per stdio loop, so its callers live as long as the loop. */
export function cliStdioHost(): McpHost {
  const hostTenantId = envTenant();
  const shared = createCallerState();
  // The rings span the loop; each folder keeps an auto-sleep bound to it, as a write's context names no folder.
  const byRoot = new Map<string, CallerState>();
  const callersAt = (root: string): CallerState => {
    let callers = byRoot.get(root);
    if (callers === undefined) {
      const run = (): Promise<void> =>
        runDetachedStoreRequest(() =>
          consolidateStore(cliStore(root), {
            config: cliConfig(root),
            tenantId: hostTenantId,
            llm: anthropicLlmFromEnv(),
          }),
        ).then(logPhaseFailures);
      callers = { ...shared, autoSleep: autoSleepHost({ hostTenantId, run }) };
      byRoot.set(root, callers);
    }
    return callers;
  };
  return {
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
        callers: callersAt(hippoRoot),
      };
    },
    runRequest: cliRequest,
  };
}
