import { evalStoreRules } from '../../infra/eval-switches.js';
import { adminActor } from '../../api/index.js';
import type { ContextReach, GlobalInReach } from '../../api/types.js';
import type { ConfiguredFolder } from '../../base/config/configured-folder.js';
import type { SyncOptions } from '../../api/agent-memories.js';
import type { Machine } from '../../base/util/agent-homes.js';
import { ledgerReachOf, type LedgerReach } from '../../api/ledger-db.js';
import type { HippoDbContext, HippoDbStore } from '../../api/hippo-db-context.js';
import { configReader, type ConfigReader } from '../../host/config-file.js';
import { autoSleepConsolidate } from '../../api/sleep/auto-sleep.js';
import { rerankerWithClef } from '../../api/recall/rows.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import type { McpContext, McpHost } from '../mcp/protocol.js';
import { allMcpTools } from '../mcp/request.js';
import type { ImportFiles } from '../importers/core.js';
import {
  askingNearestFirst,
  sqliteImportFiles,
  sqliteImportStores,
  sqliteReach,
  sqliteStore,
  runSqliteBatch,
  runSqliteHookRequest,
  runSqliteRequest,
  type SqliteStoreOptions,
  type StoreRuntime,
  type RequestStores,
} from '../open-store.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import {
  envClefSettings,
  envLossAversionRatio,
  envRuntimeSettings,
  envTenant,
} from '../../base/util/env.js';
import type { RerankerFn } from '../../base/ports/reranker.js';
import type { EmbedderFor } from '../../base/ports/embedder.js';
import { createCallerState, type AutoSleepHost, type CallerState } from '../../api/callers.js';
import { rootInfra } from '../../infra/ports.js';
import { createHost } from '../../host/host.js';
import { serverNearestAsk } from './server-nearest.js';
import { contextReach, coreEnrichment, globalEnrichment } from '../../api/hippo-db-context.js';
import type { DetachedWork } from '../../domain/search/detached-work.js';

/** The CLI process's config reader: the stdio MCP server lives as long as its host, so each call
 * parses an unchanged config.json once. */
export const cliConfig: ConfigReader = configReader(envRuntimeSettings);

/** The CLI process's Host: one command, or one stdio MCP loop, walks each folder and reads each
 * shared flag once. */
const cliHost = createHost();

/** The CLI process's outside services: one reranker registry for every command and stdio MCP
 * call it runs. */
export const cliInfra = rootInfra(cliHost);

/** A registry reranker with the CLEF transport this process's environment names, for a script
 * that reranks outside a recall. */
export function cliReranker(name: string | null | undefined): RerankerFn | null {
  return rerankerWithClef({ infra: cliInfra() }, name, envClefSettings());
}

/** The store kind the CLI opens: hippo.db, with its local tier. */
export type CliStore = HippoDbStore;

/** The CLI's store is hippo.db, which carries the local tier, so its verbs call the api
 * unchecked; the folder rides beside the api's Context for the verbs that reopen it. */
export type CliContext = HippoDbContext & { readonly hippoRoot: string };

/** One CLI command's stores, built by the CLI root and handed to its verb: each store holds the
 * command's runtime and, inside a request, that request's session. */
export interface CliCommand {
  /** hippo.db under `root`; a `hippo serve` on it answers nearest-row reads from its graph. */
  store(root: string): CliStore;
  /** A folder's hippo.db with its config, as sharing and sync take each side; the global one may
   * not exist yet. */
  folder(root: string): ConfiguredFolder<CliStore>;
  /** The api Context on `root`, which some verbs point at the global store. A command's callers
   * start empty unless its caller holds a set; a CLI write starts no sleep. */
  apiContext(root: string, tenantId: string, callers?: CallerState): CliContext;
  /** A second store a CLI read searches beside its own, with that store's config. */
  secondStore(root: string): GlobalInReach;
  /** Where a hook on `root` books its ledger rows: the folder's store, else the global one. */
  ledgerReach(root: string): LedgerReach;
  /** An import's batch on `root`: one handle per store for its synchronous run of writes. */
  importBatch(root: string): <T>(run: (files: ImportFiles) => T) => T;
  /** A vault import's batch on `root`: one handle per store for its run of guard probes. */
  storeBatch(root: string): <T>(run: (store: CliStore) => Promise<T>) => Promise<T>;
  /** Agent-memory import options: each target reads its own config.json and opens on this
   * command, scored by the process's loss-aversion ratio. */
  syncOptions(
    tenantId: string,
    machine: Machine,
    extra?: Pick<SyncOptions, 'dryRun' | 'busyWaitMs'>,
  ): SyncOptions;
  /** Runs `run` on a session of its own, one handle per store; named here so no other surface
   * opens one. */
  request<T>(run: (cli: CliCommand) => T | Promise<T>): Promise<T>;
  /** The same at the hook's lock wait; a store still busy after it skips the hook's work and
   * answers undefined. */
  hookRequest<T>(run: (cli: CliCommand) => T | Promise<T>): Promise<T | undefined>;
  /** The stdio MCP loop's host, which runs as this one command. */
  stdioHost(): McpHost<CliStore>;
  /** Keeps the work a verb starts and does not wait on, such as an embed, until the command's
   * runtime settles it as the command ends. */
  readonly detached: DetachedWork;
}

/** What a CLI helper takes of its command: the stores, the folder it works on and the tenant. */
export interface CliScope {
  readonly cli: CliCommand;
  readonly hippoRoot: string;
  readonly tenantId: string;
}

/** What a command's stores open on: its runtime, and inside a request that request's session. */
interface Scope {
  readonly runtime: StoreRuntime;
  readonly session?: RequestStores | undefined;
}

// A session's stores hold the runtime its handles return to, so a stdio loop's frames and stores
// share one.
function storeOptions({ runtime, session }: Scope): SqliteStoreOptions {
  return {
    ...evalStoreRules(envLossAversionRatio()),
    runtime: session?.runtime ?? runtime,
    session,
  };
}

// Opened here so src/surface/mcp never names the adapter.
function storeOn(scope: Scope, hippoRoot: string): CliStore {
  const opts = storeOptions(scope);
  const maxVectors = cliConfig(hippoRoot).vectorGraph.maxVectors;
  return askingNearestFirst(sqliteStore(hippoRoot, opts), {
    hippoRoot,
    ask: serverNearestAsk(hippoRoot),
    maxVectors,
    opts,
  });
}

/** The stores a CLI call on `hippoRoot` reaches, each global one with its config and on the
 * call's session. */
function reachOn(
  scope: Scope,
  hippoRoot: string,
  store: CliStore,
  embedderFor: EmbedderFor,
): ContextReach {
  const { ledger, folderFiles } = store.hippoDb;
  return contextReach(
    sqliteReach({
      hippoRoot,
      store,
      openGlobal: (root) => storeOn(scope, root),
      host: cliHost,
    }),
    cliConfig,
    embedderFor,
    { ledger, folderFiles, config: cliConfig(hippoRoot) },
  );
}

// The one place the CLI names its audit actor and builds its Context.
function contextOn(
  scope: Scope,
  hippoRoot: string,
  tenantId: string,
  callers: CallerState,
): CliContext {
  const store = storeOn(scope, hippoRoot);
  // Read here, once per command, so a long-lived caller of this function never pins a stale config.
  const config = cliConfig(hippoRoot);
  const infra = cliInfra();
  const reach = reachOn(scope, hippoRoot, store, infra.embedderFor);
  return {
    hippoRoot,
    tenantId,
    actor: adminActor(CLI_ACTOR),
    store,
    reach,
    config,
    callers,
    infra,
    enrich: coreEnrichment(store),
    detached: scope.runtime,
  };
}

/** The stores of one CLI command: each opens on `runtime` and, inside a request, on that request's
 * session. */
export function cliCommand(runtime: StoreRuntime, session?: RequestStores): CliCommand {
  const scope: Scope = { runtime, session };
  const inSession = (own: RequestStores): CliCommand => cliCommand(runtime, own);
  return {
    store: (root) => storeOn(scope, root),
    folder: (root) => ({
      store: storeOn(scope, root),
      config: cliConfig(root),
      embedderFor: cliInfra().embedderFor,
    }),
    apiContext: (root, tenantId, callers = createCallerState()) =>
      contextOn(scope, root, tenantId, callers),
    secondStore: (root) => {
      const store = storeOn(scope, root);
      return { root, store, config: cliConfig(root), enrich: globalEnrichment(store) };
    },
    ledgerReach: (root) =>
      ledgerReachOf({ reach: reachOn(scope, root, storeOn(scope, root), cliInfra().embedderFor) }),
    importBatch: (root) => (run) =>
      runSqliteBatch(
        (own) => run(sqliteImportFiles(root, storeOptions({ runtime, session: own }))),
        runtime,
      ),
    storeBatch: (root) => (run) =>
      runSqliteRequest((own) => run(storeOn({ runtime, session: own }, root)), 'cli', runtime),
    syncOptions: (tenantId, machine, extra = {}) => ({
      tenantId,
      configAt: cliConfig,
      machine,
      stores: sqliteImportStores(storeOptions(scope)),
      run: cliInfra(),
      ...extra,
    }),
    request: (run) => runSqliteRequest((own) => run(inSession(own)), 'cli', runtime),
    hookRequest: (run) => runSqliteHookRequest((own) => run(inSession(own)), runtime),
    stdioHost: () => stdioHostOn(runtime),
    detached: runtime,
  };
}

/** Creates the global store, or finishes one that was partly made: what a first share needs of
 * it. */
export function cliInitGlobal(): void {
  sqliteImportFiles(hippoHomeDir()).ensure();
}

/** `root`'s auto-sleep on a session of its own: the sleep outlives the frame whose write started
 * it. */
function rootAutoSleep(
  runtime: StoreRuntime,
  root: string,
  hostTenantId: string,
): () => Promise<void> {
  return () =>
    runSqliteRequest(
      (session) =>
        autoSleepConsolidate({
          store: storeOn({ runtime, session }, root),
          config: cliConfig(root),
          tenantId: hostTenantId,
          infra: cliInfra(),
        }),
      'cli',
      runtime,
    ).then(() => undefined);
}

/** Stdio is the operator's own process: host admin, the folder's hippo.db, and an auto-sleep
 * that runs in process. One host per stdio loop, so its callers live as long as the loop. */
function stdioHostOn(runtime: StoreRuntime): McpHost<CliStore> {
  const hostTenantId = envTenant();
  const shared = createCallerState();
  const tools = allMcpTools();
  // The rings span the loop; each folder keeps an auto-sleep and its latch, as a write's context
  // names no folder, and each frame counts on its own store.
  const byRoot = new Map<string, Pick<AutoSleepHost, 'run' | 'latch'>>();
  const callersOn = (root: string): CallerState => {
    let sleeps = byRoot.get(root);
    if (sleeps === undefined) {
      sleeps = { run: rootAutoSleep(runtime, root, hostTenantId), latch: { held: false } };
      byRoot.set(root, sleeps);
    }
    return { ...shared, autoSleep: { ...sleeps, hostTenantId } };
  };
  const contextIn =
    (session: RequestStores, signal: AbortSignal) =>
    (hippoRoot: string, tenantId: string): McpContext<CliStore> => {
      const scope: Scope = { runtime, session };
      const store = storeOn(scope, hippoRoot);
      const infra = cliInfra();
      return {
        hippoRoot,
        tenantId,
        actor: 'mcp',
        role: 'admin',
        hostAdmin: true,
        stdio: true,
        store,
        storeFor: (own) => own,
        tools,
        config: cliConfig(hippoRoot),
        reach: reachOn(scope, hippoRoot, store, infra.embedderFor),
        callers: callersOn(hippoRoot),
        infra,
        signal,
        detached: runtime,
      };
    };
  // Frames interleave, so each takes a session of its own and hands it to every store its context
  // builds.
  return {
    runFrame: (signal, run) =>
      runSqliteRequest((session) => run(contextIn(session, signal)), 'cli', runtime),
    settle: (withinMs) => runtime.settle(withinMs),
  };
}
