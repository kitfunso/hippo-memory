import { evalStoreRules } from '../../infra/eval-switches.js';
import { adminActor } from '../../api/index.js';
import {
  contextReach,
  type ContextReach,
  type ContextWith,
  type GlobalInReach,
} from '../../api/types.js';
import type { ConfiguredFolder } from '../../base/config/configured-folder.js';
import type { SyncOptions } from '../../api/agent-memories.js';
import type { Machine } from '../../base/util/agent-homes.js';
import { ledgerReachOf, type LedgerReach } from '../../api/ledger-db.js';
import type { HippoDbContext } from '../../api/hippo-db-context.js';
import { configReader, type ConfigReader } from '../../host/config-file.js';
import { autoSleepConsolidate } from '../../api/sleep/auto-sleep.js';
import { rerankerWithClef } from '../../api/recall/rows.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import type { McpContext, McpHost } from '../mcp/protocol.js';
import { allMcpTools } from '../mcp/request.js';
import type { ImportFiles } from '../importers/core.js';
import type { HippoStore, StoreGroups } from '../../base/ports/store-index.js';
import type { OptionalGroup, StoreWith } from '../../base/ports/store.js';
import {
  askingNearestFirst,
  defaultImportFiles,
  defaultImportStores,
  defaultReach,
  defaultStore,
  runStoreBatch,
  runStoreHookRequest,
  runStoreRequest,
  type StoreOptions,
  type StoreSession,
} from '../open-store.js';
import { cliRuntime } from './cli-runtime.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import {
  envClefSettings,
  envLossAversionRatio,
  envRuntimeSettings,
  envTenant,
} from '../../base/util/env.js';
import type { RerankerFn } from '../../base/ports/reranker.js';
import type { EmbedderFor } from '../../base/ports/embedder.js';
import {
  createCallerState,
  newRowsOn,
  type AutoSleepHost,
  type CallerState,
} from '../../api/callers.js';
import { rootInfra } from '../../infra/ports.js';
import { createHost } from '../../host/host.js';
import { serverNearestAsk } from './server-nearest.js';

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

// A CLI process runs one command, so the session that command opened is this root's state, as
// cliHost is, not a scope.
let commandSession: StoreSession | undefined;

// A session's stores hold the runtime its handles return to, so a stdio loop's frames and stores
// share one.
function cliStoreOptions(session: StoreSession | undefined): StoreOptions {
  return {
    ...evalStoreRules(envLossAversionRatio()),
    runtime: session?.runtime ?? cliRuntime(),
    session,
  };
}

/** The store kind the CLI opens: hippo.db, with every group and its local tier. */
export type CliStore = HippoStore & StoreGroups & Pick<HippoDbContext, 'hippoDb'>;

/** The store the CLI and the stdio MCP server open; it is opened here so src/surface/mcp never
 * names the adapter. A `hippo serve` on the same store answers its nearest-row reads from the
 * graph it holds. */
export function cliStore(
  hippoRoot: string,
  session: StoreSession | undefined = commandSession,
): CliStore {
  const opts = cliStoreOptions(session);
  const maxVectors = cliConfig(hippoRoot).vectorGraph.maxVectors;
  return askingNearestFirst(defaultStore(hippoRoot, opts), {
    hippoRoot,
    ask: serverNearestAsk(hippoRoot),
    maxVectors,
    opts,
  });
}

/** A folder's hippo.db with its config, as sharing and sync take each side; the global one may
 * not exist yet. */
export function cliFolder(hippoRoot: string): ConfiguredFolder<HippoStore & StoreGroups> {
  return {
    store: cliStore(hippoRoot),
    config: cliConfig(hippoRoot),
    embedderFor: cliInfra().embedderFor,
  };
}

/** The folder's hippo.db as an import reaches it, answering at once: the published importers
 * return their result. */
export function cliImportFiles(
  hippoRoot: string,
  session: StoreSession | undefined = commandSession,
): ImportFiles {
  return defaultImportFiles(hippoRoot, cliStoreOptions(session));
}

/** An import's batch on `hippoRoot`: one handle per store for its synchronous run of writes. */
export function cliImportBatch(hippoRoot: string): <T>(run: (files: ImportFiles) => T) => T {
  return (run) => runStoreBatch((session) => run(cliImportFiles(hippoRoot, session)), cliRuntime());
}

/** Creates the global store, or finishes one that was partly made: what a first share needs of
 * it. */
export function cliInitGlobal(): void {
  defaultImportFiles(hippoHomeDir()).ensure();
}

async function asCommand<T>(session: StoreSession, run: () => T | Promise<T>): Promise<T> {
  const outer = commandSession;
  commandSession = session;
  try {
    return await run();
  } finally {
    commandSession = outer;
  }
}

/** One handle per store at the hook's lock wait; a store still busy after it skips the hook's
 * work and answers undefined. */
export function cliHookRequest<T>(run: () => T | Promise<T>): Promise<T | undefined> {
  return runStoreHookRequest((session) => asCommand(session, run), cliRuntime());
}

/** A CLI verb's agent-memory import options: each target reads its own config.json and opens
 * through the default store, scored by this process's loss-aversion ratio as cliStore's stores
 * are. */
export function cliSyncOptions(
  tenantId: string,
  machine: Machine,
  extra: Pick<SyncOptions, 'dryRun' | 'busyWaitMs'> = {},
): SyncOptions {
  const stores = defaultImportStores(cliStoreOptions(commandSession));
  return { tenantId, configAt: cliConfig, machine, stores, run: cliInfra(), ...extra };
}

/** A vault import's batch on `hippoRoot`: one handle per store for its run of guard probes. */
export function cliStoreBatch(
  hippoRoot: string,
): <T>(run: (store: HippoStore & StoreGroups) => Promise<T>) => Promise<T> {
  return (run) =>
    runStoreRequest((session) => run(cliStore(hippoRoot, session)), 'cli', cliRuntime());
}

/** The session a scoped CLI verb runs in, one handle per store; named here so no other surface
 * opens one. */
export function cliRequest<T>(run: () => T | Promise<T>): Promise<T> {
  return runStoreRequest((session) => asCommand(session, run), 'cli', cliRuntime());
}

/** The CLI's store is hippo.db, which sets every optional group, so its verbs call the api
 * unchecked; the folder rides beside the api's Context for the verbs that reopen it. */
export type CliContext = ContextWith<OptionalGroup> &
  HippoDbContext & { readonly hippoRoot: string };

/** The stores a CLI call on `hippoRoot` reaches, each global one with its config and on the
 * call's session. */
function cliReach(
  hippoRoot: string,
  store: HippoStore & StoreGroups,
  embedderFor: EmbedderFor,
  session = commandSession,
): ContextReach {
  const { ledger, folderFiles } = store;
  return contextReach(
    defaultReach({
      hippoRoot,
      store,
      openGlobal: (root) => cliStore(root, session),
      host: cliHost,
    }),
    cliConfig,
    embedderFor,
    { ledger, folderFiles, config: cliConfig(hippoRoot) },
  );
}

// The one place the CLI names its audit actor and builds its store; root is a parameter because
// some verbs target the global store. A command's callers start empty unless its caller holds a
// set; a CLI write starts no sleep.
export function cliApiContext(
  hippoRoot: string,
  tenantId: string,
  callers: CallerState = createCallerState(),
): CliContext {
  const store = cliStore(hippoRoot);
  // Read here, once per command, so a long-lived caller of this function never pins a stale config.
  const config = cliConfig(hippoRoot);
  const infra = cliInfra();
  const reach = cliReach(hippoRoot, store, infra.embedderFor);
  return {
    hippoRoot,
    tenantId,
    actor: adminActor(CLI_ACTOR),
    store,
    hippoDb: store.hippoDb,
    reach,
    config,
    callers,
    infra,
  };
}

/** A second store a CLI read searches beside its own, with that store's config. */
export function cliSecondStore(root: string): GlobalInReach {
  return { root, store: cliStore(root), config: cliConfig(root) };
}

/** Where a hook on `hippoRoot` books its ledger rows: the folder's store, else the global one,
 * probed once here. */
export function cliLedgerReach(hippoRoot: string): LedgerReach {
  return ledgerReachOf({
    reach: cliReach(hippoRoot, cliStore(hippoRoot), cliInfra().embedderFor),
  });
}

/** `root`'s auto-sleep on a session of its own: the sleep outlives the frame whose write started
 * it. */
function rootAutoSleep(root: string, hostTenantId: string): () => Promise<void> {
  return () =>
    runStoreRequest(
      (session) =>
        autoSleepConsolidate({
          store: cliStore(root, session),
          config: cliConfig(root),
          tenantId: hostTenantId,
          infra: cliInfra(),
        }),
      'cli',
      cliRuntime(),
    ).then(() => undefined);
}

/** Stdio is the operator's own process: host admin, the folder's hippo.db, and an auto-sleep
 * that runs in process. One host per stdio loop, so its callers live as long as the loop, which
 * runs as one command on that command's runtime. */
export function cliStdioHost(): McpHost<CliStore> {
  const hostTenantId = envTenant();
  const shared = createCallerState();
  const tools = allMcpTools();
  // The rings span the loop; each folder keeps an auto-sleep and its latch, as a write's context
  // names no folder, and each frame counts on its own store.
  const byRoot = new Map<string, Pick<AutoSleepHost, 'run' | 'latch'>>();
  const callersOn = (root: string, store: StoreWith<'reports'>): CallerState => {
    let sleeps = byRoot.get(root);
    if (sleeps === undefined) {
      sleeps = { run: rootAutoSleep(root, hostTenantId), latch: { held: false } };
      byRoot.set(root, sleeps);
    }
    return { ...shared, autoSleep: { ...sleeps, hostTenantId, newSince: newRowsOn(store) } };
  };
  const contextIn =
    (session: StoreSession, signal: AbortSignal) =>
    (hippoRoot: string, tenantId: string): McpContext<CliStore> => {
      const store = cliStore(hippoRoot, session);
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
        reach: cliReach(hippoRoot, store, infra.embedderFor, session),
        callers: callersOn(hippoRoot, store),
        infra,
        signal,
      };
    };
  // Frames interleave, so each takes a session of its own and hands it to every store its context
  // builds.
  return {
    runFrame: (signal, run) =>
      runStoreRequest((session) => run(contextIn(session, signal)), 'cli', cliRuntime()),
  };
}
