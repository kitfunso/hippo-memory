// Runs the adapters for one pass and routes each container to its store; src/api/agent-memories.ts
// picks the passes.
import path from 'node:path';
import { plural } from '../../base/util/format.js';
import type { Machine } from '../../base/util/agent-homes.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { HippoConfig } from '../../base/config/config.js';
import { strengthModelFor } from '../../base/memory/eval-switches.js';
import type { EmbedRun } from '../search/embed-memories.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { namesFoldedInto } from './project-folds.js';
import { syncContainer, type ContainerOutcome } from './apply.js';
import { liveUnder, type ContainerWork, type StoreSession } from './container-view.js';
import { handOver, warnUnpurged } from './handover.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { geminiAdapter } from './gemini.js';
import { legacyWork, type LegacyWork } from './legacy.js';
import { openclawAdapter } from './openclaw.js';
import { qwenCodeAdapter } from './qwen-code.js';
import {
  addTally,
  emptyReport,
  toolReport,
  type ImportReport,
  type ToolReport,
} from '../../base/memory/agent-memory-report.js';
import { containerId, containerPrefix, type ContainerMachine } from './source.js';
import {
  AGENT_MEMORY_TOOLS,
  isToolId,
  toolSourcePrefix,
  type AgentMemoryTool,
  type Scope,
  type ToolId,
} from '../../base/memory/agent-memory-tools.js';
import type { Adapter, ImportStore, ImportStores, Listing } from './types.js';

export const ADAPTERS: readonly Adapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  geminiAdapter,
  copilotAdapter,
  openclawAdapter,
  qwenCodeAdapter,
];

/** Overrides config because `hippo init` creates the store in the same command that imports. */
export const TOOLS_ENV = 'HIPPO_AGENT_MEMORY_TOOLS';

export interface SyncOptions {
  /** The tenant every imported row is written as; the caller's root resolved it. */
  readonly tenantId: string;
  readonly machine: Machine;
  /** Reads one store's config; the caller's, so this module never touches config.json. */
  readonly configAt: (hippoRoot: string) => HippoConfig;
  /** Writes nothing: each container's transaction rolls back, and a missing store is stood in
   * for by an empty one. */
  readonly dryRun?: boolean;
  /** How long a busy store is waited on before its containers are skipped. */
  readonly busyWaitMs?: number;
  /** Opens each target store; the caller's, so this module never builds a store adapter. */
  readonly stores: ImportStores;
  /** The root's eval switches and clock, which score and stamp each revived or new row. */
  readonly run: EmbedRun;
}

/** One pass: the listing it takes from each adapter and the store its rows land in. */
export interface Pass {
  readonly scope: Scope;
  /** The store rows land in. */
  readonly target: string;
  /** The store the command runs in; without the variable, its config must allow a tool as well. */
  readonly invoking: string;
  readonly list: (adapter: Adapter) => Listing | null;
  readonly legacy: boolean;
  readonly originProject: string | undefined;
  /** The project's names before its id, whose global-store imports this pass moves under the id. */
  readonly legacyOrigins: readonly string[];
  /** Set aside the global store's copies of each container this pass syncs into a local store. */
  readonly handover: boolean;
}

/**
 * The variable when set (empty or `none` is off); else the tools both the invoking and the target
 * store's config allow.
 */
export function allowedTools(
  opts: Pick<SyncOptions, 'machine' | 'configAt'>,
  invoking: string,
  target: string,
  warnings: string[],
): Set<ToolId> {
  const env = opts.machine.env;
  const fromEnv = env[TOOLS_ENV];
  if (fromEnv !== undefined) {
    const listed =
      fromEnv.trim().toLowerCase() === 'none'
        ? []
        : fromEnv
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t !== '');
    // The value is never echoed: a secret set in this variable by mistake would reach the log.
    let unknown = 0;
    const known = knownTools(listed, () => unknown++);
    if (unknown > 0) {
      warnings.push(unknownToolsIgnored(TOOLS_ENV, plural(unknown, 'unknown agent memory tool')));
    }
    return known;
  }
  const mine = configuredTools(opts, invoking, warnings);
  const theirs = configuredTools(opts, target, warnings);
  return new Set(
    AGENT_MEMORY_TOOLS.map((t) => t.id).filter(
      (id) => (mine === null || mine.has(id)) && (theirs === null || theirs.has(id)),
    ),
  );
}

function configuredTools(
  opts: Pick<SyncOptions, 'configAt'>,
  root: string,
  warnings: string[],
): Set<ToolId> | null {
  const tools = opts.configAt(root).agentMemories.tools;
  if (tools === null) return null;
  return knownTools(tools, (id) =>
    warnings.push(
      unknownToolsIgnored('config agentMemories.tools', `unknown agent memory tool "${id}"`),
    ),
  );
}

function unknownToolsIgnored(where: string, what: string): string {
  return `${where}: ${what} ignored (known: ${AGENT_MEMORY_TOOLS.map((t) => t.id).join(', ')})`;
}

function knownTools(ids: readonly string[], onUnknown: (id: string) => void): Set<ToolId> {
  const out = new Set<ToolId>();
  for (const id of ids) {
    if (isToolId(id)) out.add(id);
    else onUnknown(id);
  }
  return out;
}

/** Lists each allowed tool's containers for `pass` and syncs them into its target store; a
 * failure is a warning. */
export async function runPass(pass: Pass, opts: SyncOptions): Promise<ImportReport> {
  const report = emptyReport();
  const allowed = allowedTools(opts, pass.invoking, pass.target, report.warnings);
  const listings = ADAPTERS.filter((a) => allowed.has(a.tool)).flatMap((a) =>
    listSafely(a, pass, report),
  );
  const hasItems = listings.some((l) => l.containers.some((c) => c.items.length > 0));
  let store: OpenStore | null = null;
  let synced: ContainerWork[] = [];
  try {
    store = await openTarget(pass.target, hasItems, opts);
    if (store !== null) synced = await syncStore({ pass, listings, store, opts, report });
  } catch (err) {
    const why = opts.stores.isBusy(err) ? 'the store was busy' : errorMessage(err);
    report.warnings.push(`agent memories not synced into ${pass.target}: ${why}`);
  } finally {
    await store?.store.close();
  }
  if (pass.handover && !opts.dryRun) {
    await handOver(synced, path.dirname(pass.target), opts, report);
  }
  return report;
}

function listSafely(adapter: Adapter, pass: Pass, report: ImportReport): Listing[] {
  const tool = toolReport(report, adapter.tool);
  let listing: Listing | null;
  try {
    listing = pass.list(adapter);
  } catch (err) {
    log.debug(`${tool.label}: listing failed`, errorFields(err));
    report.warnings.push(`${tool.label}: ${errorMessage(err)}`);
    return [];
  }
  if (listing === null) return [];
  if (!tool.homes.includes(listing.home)) tool.homes.push(listing.home);
  report.warnings.push(...listing.warnings.map((w) => `${tool.label}: ${w}`));
  for (const c of listing.containers) {
    tool.containers.push({
      scope: c.scope,
      path: c.path,
      store: pass.target,
      items: c.items.length,
      readable: c.readable,
    });
    report.warnings.push(...c.warnings.map((w) => `${tool.label}: ${w}`));
  }
  return [listing];
}

interface OpenStore {
  readonly store: ImportStore;
  /** The folder whose config scores the rows; a stand-in plans by the absent target's, its
   * defaults. */
  readonly root: string;
  readonly global: boolean;
}

/** A store that does not exist yet is created only when there is something to put in it; a dry
 * run plans against an empty stand-in. */
async function openTarget(
  target: string,
  hasItems: boolean,
  opts: SyncOptions,
): Promise<OpenStore | null> {
  const global = opts.machine.isGlobalRoot(target);
  if (!opts.stores.exists(target)) {
    if (opts.dryRun) return { store: opts.stores.standIn(), root: target, global };
    if (!hasItems) return null;
    await opts.stores.create(target);
  }
  return { store: opts.stores.open(target, { busyWaitMs: opts.busyWaitMs }), root: target, global };
}

function storeSession(
  pass: Pass,
  store: OpenStore,
  opts: SyncOptions,
  legacy: LegacyWork | null,
): StoreSession {
  const config = opts.configAt(store.root);
  return {
    store: store.store,
    tenantId: opts.tenantId,
    baseHalfLifeDays: config.defaultHalfLifeDays,
    strength: strengthModelFor(opts.run.evalSwitches, config.runtime),
    now: opts.run.clock(),
    originProject: pass.originProject,
    visible: store.global ? [pass.originProject ?? '', ...pass.legacyOrigins] : null,
    adopted: legacy?.adopted ?? new Set(),
    dryRun: opts.dryRun === true,
  };
}

/** One pass's store as each of its containers syncs into it. */
interface PassStore {
  readonly pass: Pass;
  readonly session: StoreSession;
  readonly legacy: LegacyWork | null;
  /** The project's earlier names; each container's rows under them move to its prefix. */
  readonly earlier: readonly string[];
  /** A project's rows in the global store are parted by origin: a worktree and its main checkout
   * share a folder. */
  readonly partition: string | null;
  readonly machine: ContainerMachine;
  readonly isBusy: ImportStores['isBusy'];
}

type SyncedContainer = ContainerOutcome & { readonly work: ContainerWork };

interface SyncStoreOptions {
  readonly pass: Pass;
  readonly listings: readonly Listing[];
  readonly store: OpenStore;
  readonly opts: SyncOptions;
  readonly report: ImportReport;
}

async function syncStore({
  pass,
  listings,
  store,
  opts,
  report,
}: SyncStoreOptions): Promise<ContainerWork[]> {
  const legacy = pass.legacy ? await legacyWork(store.store, opts.tenantId, listings) : null;
  const session = storeSession(pass, store, opts, legacy);
  const partition = store.global && pass.scope === 'project' ? (pass.originProject ?? '') : null;
  const earlier =
    partition === null || partition === ''
      ? []
      : await earlierNames(store.store, opts.tenantId, [partition, ...pass.legacyOrigins]);
  const at: PassStore = {
    pass,
    session,
    legacy,
    earlier,
    partition,
    machine: opts.machine,
    isBusy: opts.stores.isBusy,
  };
  const synced: ContainerWork[] = [];
  let remembered = 0;
  for (const listing of listings) {
    for (const outcome of await syncListing(at, listing, report)) {
      synced.push(outcome.work);
      remembered += outcome.tally.imported + outcome.tally.replaced;
    }
  }
  if (remembered > 0 && !session.dryRun) await bumpRemembered(store.store, remembered, report);
  return synced;
}

async function syncListing(
  at: PassStore,
  listing: Listing,
  report: ImportReport,
): Promise<SyncedContainer[]> {
  const tool = toolOf(listing.tool);
  const out = toolReport(report, tool.id);
  const synced: SyncedContainer[] = [];
  for (const container of listing.containers) {
    if (!container.readable) {
      out.tally.unreadable++;
      continue;
    }
    const work = containerWork(tool, container, {
      machine: at.machine,
      legacy: at.legacy,
      origin: at.partition ?? '',
      earlier: at.earlier,
    });
    const outcome = await syncOne(at.session, work, { out, report, isBusy: at.isBusy });
    if (outcome === null) continue;
    synced.push({ ...outcome, work });
    warnUnpurged(outcome.unpurged, report);
  }
  if (at.session.dryRun) {
    out.unlisted += await unlistedRows(at.session, {
      tool,
      scope: at.pass.scope,
      listing,
      machine: at.machine,
      partition: at.partition === null ? null : [at.partition, ...at.earlier],
    });
  }
  return synced;
}

/** The legacy names plus every name a merge or repair folded into the project; the audit read
 * runs once per pass. */
async function earlierNames(
  store: ImportStore,
  tenantId: string,
  names: readonly string[],
): Promise<string[]> {
  const [id, ...legacyOrigins] = names;
  const folded = await namesFoldedInto(store.auditLog, tenantId, names);
  return [...legacyOrigins, ...folded].filter((n) => n !== '' && n !== id);
}

interface ContainerWorkOptions {
  readonly machine: ContainerMachine;
  readonly legacy: LegacyWork | null;
  readonly origin: string;
  readonly earlier: readonly string[];
}

function containerWork(
  tool: AgentMemoryTool,
  container: ContainerWork['container'],
  options: ContainerWorkOptions,
): ContainerWork {
  const { machine, legacy, origin, earlier } = options;
  const none = new Map<string, readonly MemoryEntry[]>();
  const own = tool.id === 'claude-code' ? legacy?.byContainer.get(container.path) : undefined;
  const prefixOf = (name: string): string =>
    containerPrefix(tool.id, containerId(container.path, container.scope, machine, name));
  return {
    tool,
    container,
    prefix: prefixOf(origin),
    adopt: own?.adopt ?? none,
    replace: own?.replace ?? none,
    legacyPrefixes: earlier.map(prefixOf),
  };
}

/** Null when the container was skipped: a busy store, or one that changed under both plans,
 * waits for the next sync; any other failure is a warning and the sync goes on. */
async function syncOne(
  session: StoreSession,
  work: ContainerWork,
  {
    out,
    report,
    isBusy,
  }: {
    readonly out: ToolReport;
    readonly report: ImportReport;
    readonly isBusy: PassStore['isBusy'];
  },
): Promise<ContainerOutcome | null> {
  try {
    const outcome = await syncContainer(session, work);
    if (outcome === null) {
      out.tally.busy++;
      report.warnings.push(
        `${out.label}: ${work.container.path} skipped, the store changed while it was read`,
      );
      return null;
    }
    addTally(out.tally, outcome.tally);
    return outcome;
  } catch (err) {
    log.debug(`${out.label}: ${work.container.path} not synced`, errorFields(err));
    if (isBusy(err)) {
      out.tally.busy++;
      report.warnings.push(`${out.label}: ${work.container.path} skipped, the store was busy`);
    } else {
      report.warnings.push(`${out.label}: ${work.container.path} not synced: ${errorMessage(err)}`);
    }
    return null;
  }
}

async function bumpRemembered(
  store: ImportStore,
  remembered: number,
  report: ImportReport,
): Promise<void> {
  try {
    await store.lessonWrites.bumpRemembered(remembered);
  } catch (err) {
    log.debug('remembered counter not updated', errorFields(err));
    report.warnings.push(`remembered counter not updated: ${errorMessage(err)}`);
  }
}

/** Dry run only: kept rows of this scope in containers this run did not list (a moved project's
 * old folder); `partition` limits it to one project's names. */
interface UnlistedRowsOptions {
  readonly tool: AgentMemoryTool;
  readonly scope: Scope;
  readonly listing: Listing;
  readonly machine: ContainerMachine;
  readonly partition: readonly string[] | null;
}

async function unlistedRows(session: StoreSession, options: UnlistedRowsOptions): Promise<number> {
  const { tool, scope, listing, machine, partition } = options;
  const listed = listing.containers.flatMap((c) =>
    (partition ?? ['']).map((name) =>
      containerPrefix(tool.id, containerId(c.path, c.scope, machine, name)),
    ),
  );
  const prefix = `${toolSourcePrefix(tool.id)}${scope === 'project' ? 'p' : 'u'}-`;
  return (await liveUnder(session.store, session.tenantId, prefix))
    .filter((row) => row.tags.includes(tool.tag) && !listed.some((p) => row.source.startsWith(p)))
    .filter((row) => partition === null || partition.includes(row.originProject ?? '')).length;
}

function toolOf(id: ToolId): AgentMemoryTool {
  const tool = AGENT_MEMORY_TOOLS.find((t) => t.id === id);
  if (tool === undefined) throw new Error(`agent memory sync: no tool ${id}`);
  return tool;
}
