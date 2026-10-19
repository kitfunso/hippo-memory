// Runs the adapters and routes each container to its store: the project pass, the user pass and their call sites (plan
// designs 2, 8, 11).
import path from 'node:path';
import { plural } from '../util/format.js';
import type { Machine } from '../util/agent-homes.js';
import { errorMessage } from '../util/log.js';
import type { HippoConfig } from '../core/config.js';
import { strengthOptionsOf, type MemoryEntry } from '../core/memory.js';
import { namesFoldedInto } from './project-folds.js';
import {
  isGlobalStoreRoot,
  isInitialized,
  projectNames,
  resolveGlobalRootDir,
  resolveProjectIdentity,
  type ProjectIdentity,
} from '../core/project-identity.js';
import { duplicateKey, heldTextKeys } from '../util/same-text.js';
import type { AgentImport, ImportTarget } from '../store/port/agent-import.js';
import { syncContainer, type ContainerOutcome, type ContainerWork, type StoreSession } from './apply.js';
import { claudeCodeAdapter, claudeTranscriptListing, transcriptNotesProject } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { geminiAdapter } from './gemini.js';
import { legacyWork, type LegacyWork } from './legacy.js';
import { openclawAdapter } from './openclaw.js';
import { qwenCodeAdapter } from './qwen-code.js';
import { addTally, emptyReport, mergeReports, toolReport, type ImportReport, type ToolReport } from './report.js';
import { containerId, containerPrefix, splitSource } from './source.js';
import {
  AGENT_MEMORY_SOURCE_PREFIX,
  AGENT_MEMORY_TOOLS,
  isToolId,
  toolSourcePrefix,
  type AgentMemoryTool,
  type ToolId,
} from '../core/agent-memory-tools.js';
import type { Adapter, AdapterContext, Listing, Scope } from './types.js';

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
  /** Writes nothing: each container's transaction rolls back, and a missing store is stood in for by an empty one. */
  readonly dryRun?: boolean;
  /** How long a busy store is waited on before its containers are skipped. */
  readonly busyWaitMs?: number;
  /** Opens each target store; the caller's, so this module never builds a store adapter. */
  readonly agentImport: AgentImport;
}

interface Pass {
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
 * init, sleep, `import --agents` and the daily runner: a local store gets its project pass then the user pass; the
 * global store the user pass only.
 */
export function importForStore(hippoRoot: string, opts: SyncOptions): ImportReport {
  if (isGlobalStoreRoot(hippoRoot)) return importUserMemories(hippoRoot, opts);
  const report = importProjectMemories(hippoRoot, opts);
  mergeReports(report, importUserMemories(hippoRoot, opts));
  return report;
}

/** A local store's project pass with legacy adoption; `init --scan` runs it per repository and the user pass once. */
export function importProjectMemories(hippoRoot: string, opts: SyncOptions): ImportReport {
  const ctx = context(opts.machine, { projectRoot: path.dirname(hippoRoot) });
  return runPass(
    {
      scope: 'project',
      target: hippoRoot,
      invoking: hippoRoot,
      list: (a) => a.list(ctx, 'project'),
      legacy: true,
      originProject: undefined,
      legacyOrigins: [],
      handover: true,
    },
    opts,
  );
}

/** Every tool's user-level memory into the global store, created on demand, with no origin. */
export function importUserMemories(invokingRoot: string, opts: SyncOptions): ImportReport {
  const ctx = context(opts.machine, {});
  return runPass(
    {
      scope: 'user',
      target: resolveGlobalRootDir(),
      invoking: invokingRoot,
      list: (a) => a.list(ctx, 'user'),
      legacy: false,
      originProject: '',
      legacyOrigins: [],
      handover: false,
    },
    opts,
  );
}

/** Session end in a folder with no store of its own: the session's project into the
 * global store with its origin, the session folder's notes, then the user pass. */
export function importAtSessionEnd(cwd: string, transcriptPath: string | undefined, opts: SyncOptions): ImportReport {
  const globalRoot = resolveGlobalRootDir();
  const ctx = context(opts.machine, { projectRoot: cwd });
  const report = runPass(
    {
      scope: 'project',
      target: globalRoot,
      invoking: globalRoot,
      list: (a) => a.list(ctx, 'project'),
      legacy: false,
      ...projectOrigins(resolveProjectIdentity(cwd)),
      handover: false,
    },
    opts,
  );
  if (transcriptPath !== undefined) mergeReports(report, importSessionFolder(globalRoot, transcriptPath, cwd, opts));
  mergeReports(report, importUserMemories(globalRoot, opts));
  return report;
}

/** The session folder's notes under the project Claude filed them for, never cwd's: a session begun at
 * home keeps its home notes user-global wherever it ends. No git call, so post-compact can run it. */
export function importSessionFolder(
  hippoRoot: string,
  transcriptPath: string,
  cwd: string | null,
  opts: SyncOptions,
): ImportReport {
  const project = transcriptNotesProject(transcriptPath, cwd, opts.machine);
  if (project === null) return emptyReport();
  // A project store takes its own project's notes; another project's, or home's, go to the global store, which parts
  // them by origin.
  const own = isGlobalStoreRoot(hippoRoot) || project.name === resolveProjectIdentity(path.dirname(hippoRoot)).name;
  const target = own ? hippoRoot : resolveGlobalRootDir();
  const ctx = context(opts.machine, {});
  return runPass(
    {
      scope: 'project',
      target,
      invoking: hippoRoot,
      legacy: false,
      ...projectOrigins(project),
      handover: false,
      list: (a) => (a.tool === 'claude-code' ? claudeTranscriptListing(ctx, transcriptPath) : null),
    },
    opts,
  );
}

function projectOrigins(project: ProjectIdentity): Pick<Pass, 'originProject' | 'legacyOrigins'> {
  return { originProject: project.name, legacyOrigins: projectNames(project).slice(1) };
}

function context(machine: Machine, extra: Pick<AdapterContext, 'projectRoot'>): AdapterContext {
  return { home: machine.home, env: machine.env, platform: machine.platform, ...extra };
}

/**
 * The variable when set (empty or `none` is off); else the tools both the invoking and the target store's config allow.
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
    if (unknown > 0) warnings.push(unknownToolsIgnored(TOOLS_ENV, plural(unknown, 'unknown agent memory tool')));
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

function configuredTools(opts: Pick<SyncOptions, 'configAt'>, root: string, warnings: string[]): Set<ToolId> | null {
  const tools = opts.configAt(root).agentMemories.tools;
  if (tools === null) return null;
  return knownTools(tools, (id) =>
    warnings.push(unknownToolsIgnored('config agentMemories.tools', `unknown agent memory tool "${id}"`)),
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

function runPass(pass: Pass, opts: SyncOptions): ImportReport {
  const ai = opts.agentImport;
  const report = emptyReport();
  const allowed = allowedTools(opts, pass.invoking, pass.target, report.warnings);
  const listings = ADAPTERS.filter((a) => allowed.has(a.tool)).flatMap((a) => listSafely(a, pass, report));
  const hasItems = listings.some((l) => l.containers.some((c) => c.items.length > 0));
  let store: OpenStore | null = null;
  let synced: ContainerWork[] = [];
  try {
    store = openTarget(ai, pass.target, hasItems, opts);
    if (store !== null) synced = syncStore(pass, listings, store, opts, report);
  } catch (err) {
    report.warnings.push(
      `agent memories not synced into ${pass.target}: ${ai.isBusy(err) ? 'the store was busy' : errorMessage(err)}`,
    );
  } finally {
    store?.target.close();
  }
  if (pass.handover && !opts.dryRun) handOver(ai, synced, path.dirname(pass.target), opts, report);
  return report;
}

function listSafely(adapter: Adapter, pass: Pass, report: ImportReport): Listing[] {
  const tool = toolReport(report, adapter.tool);
  let listing: Listing | null;
  try {
    listing = pass.list(adapter);
  } catch (err) {
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
  readonly ai: AgentImport;
  readonly target: ImportTarget;
  readonly global: boolean;
}

/**
 * A store that does not exist yet is created only when there is something to put in it; a dry run plans against an
 * empty stand-in.
 */
function openTarget(ai: AgentImport, target: string, hasItems: boolean, opts: SyncOptions): OpenStore | null {
  const global = isGlobalStoreRoot(target);
  if (!isInitialized(target)) {
    if (opts.dryRun) return { ai, target: ai.openStandIn(opts.tenantId), global };
    if (!hasItems) return null;
    ai.create(target);
  }
  return { ai, target: ai.open(target, opts.tenantId, { busyWaitMs: opts.busyWaitMs }), global };
}

function storeSession(pass: Pass, store: OpenStore, opts: SyncOptions, legacy: LegacyWork | null): StoreSession {
  const config = opts.configAt(store.target.root);
  return {
    target: store.target,
    tenantId: store.target.tenantId,
    baseHalfLifeDays: config.defaultHalfLifeDays,
    strength: strengthOptionsOf(config.runtime),
    originProject: pass.originProject,
    isDuplicate: duplicateCheck(store, [pass.originProject ?? '', ...pass.legacyOrigins], legacy?.adopted ?? new Set()),
    dryRun: opts.dryRun === true,
  };
}

function syncStore(
  pass: Pass,
  listings: readonly Listing[],
  store: OpenStore,
  opts: SyncOptions,
  report: ImportReport,
): ContainerWork[] {
  const legacy = pass.legacy ? legacyWork(store.target, listings) : null;
  const session = storeSession(pass, store, opts, legacy);
  // A project's rows in the global store are parted by origin: a worktree and its main checkout share a Claude folder.
  const partition = store.global && pass.scope === 'project' ? (pass.originProject ?? '') : null;
  const earlier =
    partition === null || partition === '' ? [] : earlierNames(store.target, partition, pass.legacyOrigins);
  const synced: ContainerWork[] = [];
  let remembered = 0;
  for (const listing of listings) {
    const tool = toolOf(listing.tool);
    const out = toolReport(report, tool.id);
    for (const container of listing.containers) {
      if (!container.readable) {
        out.tally.unreadable++;
        continue;
      }
      const work = containerWork(tool, container, {
        platform: opts.machine.platform,
        legacy,
        origin: partition ?? '',
        earlier,
      });
      const outcome = syncOne(store.ai, session, work, { out, report });
      if (outcome === null) continue;
      synced.push(work);
      remembered += outcome.tally.imported + outcome.tally.replaced;
      if (!session.dryRun) afterCommit(store.target, outcome, report);
    }
    if (session.dryRun) {
      out.unlisted += unlistedRows(store.target, {
        tool,
        scope: pass.scope,
        listing,
        platform: opts.machine.platform,
        partition: partition === null ? null : [partition, ...earlier],
      });
    }
  }
  if (remembered > 0 && !session.dryRun) bumpRemembered(store.target, remembered, report);
  return synced;
}

/** The legacy names plus every name a merge or repair folded into the project; the audit read runs once per pass. */
function earlierNames(target: ImportTarget, id: string, legacyOrigins: readonly string[]): string[] {
  const names = [id, ...legacyOrigins];
  return [...legacyOrigins, ...namesFoldedInto(target.projectTagReads(), names)].filter((n) => n !== '' && n !== id);
}

interface ContainerWorkOptions {
  readonly platform: NodeJS.Platform;
  readonly legacy: LegacyWork | null;
  readonly origin: string;
  readonly earlier: readonly string[];
}

function containerWork(
  tool: AgentMemoryTool,
  container: ContainerWork['container'],
  options: ContainerWorkOptions,
): ContainerWork {
  const { platform, legacy, origin, earlier } = options;
  const none = new Map<string, readonly MemoryEntry[]>();
  const own = tool.id === 'claude-code' ? legacy?.byContainer.get(container.path) : undefined;
  const prefixOf = (name: string): string =>
    containerPrefix(tool.id, containerId(container.path, container.scope, platform, name));
  return {
    tool,
    container,
    prefix: prefixOf(origin),
    adopt: own?.adopt ?? none,
    replace: own?.replace ?? none,
    legacyPrefixes: earlier.map(prefixOf),
  };
}

/**
 * Null when the container was skipped: a busy store waits for the next sync, any other failure is a warning and the
 * sync goes on.
 */
function syncOne(
  ai: AgentImport,
  session: StoreSession,
  work: ContainerWork,
  { out, report }: { readonly out: ToolReport; readonly report: ImportReport },
): ContainerOutcome | null {
  try {
    const outcome = syncContainer(session, work);
    addTally(out.tally, outcome.tally);
    return outcome;
  } catch (err) {
    if (ai.isBusy(err)) {
      out.tally.busy++;
      report.warnings.push(`${out.label}: ${work.container.path} skipped, the store was busy`);
    } else {
      report.warnings.push(`${out.label}: ${work.container.path} not synced: ${errorMessage(err)}`);
    }
    return null;
  }
}

function afterCommit(
  target: ImportTarget,
  outcome: Pick<ContainerOutcome, 'mirror' | 'purge'>,
  report: ImportReport,
): void {
  for (const entry of outcome.mirror) target.writeMirror(entry);
  for (const id of outcome.purge) {
    try {
      target.removeMirror(id);
    } catch (err) {
      // A legacy-mirror import on an empty store would bring the row back live, and the next sync sets it aside again.
      report.warnings.push(`mirror of ${id} not removed: ${errorMessage(err)}`);
    }
  }
}

function bumpRemembered(target: ImportTarget, remembered: number, report: ImportReport): void {
  try {
    target.bumpRemembered(remembered);
  } catch (err) {
    report.warnings.push(`remembered counter not updated: ${errorMessage(err)}`);
  }
}

/**
 * Design 6: only text stored by another path counts, and in the global store only rows visible where the new row goes.
 */
function duplicateCheck(
  store: OpenStore,
  origins: readonly string[],
  adopted: ReadonlySet<string>,
): (text: string) => boolean {
  const visible = store.global ? origins : null;
  // Only the rows holding the text's words can hold the text, so the store is asked for those alone.
  return (text) => {
    const key = duplicateKey(text);
    return store.target
      .rowsHoldingOutsideSourcePrefix(text, AGENT_MEMORY_SOURCE_PREFIX, visible)
      .some((r) => !adopted.has(r.id) && heldTextKeys(r).includes(key));
  };
}

/**
 * Dry run only: kept rows of this scope in containers this run did not list (a moved project's old folder); `partition`
 * limits it to one project's names.
 */
interface UnlistedRowsOptions {
  readonly tool: AgentMemoryTool;
  readonly scope: Scope;
  readonly listing: Listing;
  readonly platform: NodeJS.Platform;
  readonly partition: readonly string[] | null;
}

function unlistedRows(target: ImportTarget, options: UnlistedRowsOptions): number {
  const { tool, scope, listing, platform, partition } = options;
  const listed = listing.containers.flatMap((c) =>
    (partition ?? ['']).map((name) => containerPrefix(tool.id, containerId(c.path, c.scope, platform, name))),
  );
  return target
    .liveBySourcePrefix(`${toolSourcePrefix(tool.id)}${scope === 'project' ? 'p' : 'u'}-`)
    .filter((row) => row.tags.includes(tool.tag) && !listed.some((p) => row.source.startsWith(p)))
    .filter((row) => partition === null || partition.includes(row.originProject ?? '')).length;
}

/**
 * Design 2's handover: rows the store-less hook path left in the global store, under this project's origin, for
 * containers its store now syncs.
 */
function handOver(
  ai: AgentImport,
  synced: readonly ContainerWork[],
  projectRoot: string,
  opts: SyncOptions,
  report: ImportReport,
): void {
  const globalRoot = resolveGlobalRootDir();
  if (synced.length === 0 || !isInitialized(globalRoot)) return;
  let target: ImportTarget | undefined;
  try {
    target = ai.open(globalRoot, opts.tenantId, { busyWaitMs: opts.busyWaitMs });
    // A folder with no git and no marker wrote as '' before its store existed, and as its own name after.
    // Names folded into this project's in the global store were its rows too.
    const names = projectNames(resolveProjectIdentity(projectRoot));
    const origins = [...new Set([...names, ...namesFoldedInto(target.projectTagReads(), names), ''])];
    for (const work of synced) handOverContainer(target, work, { origins, platform: opts.machine.platform, report });
  } catch (err) {
    report.warnings.push(
      `global copies not handed over: ${ai.isBusy(err) ? 'the global store was busy' : errorMessage(err)}`,
    );
  } finally {
    target?.close();
  }
}

interface HandOverContainerOptions {
  readonly origins: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly report: ImportReport;
}

function handOverContainer(target: ImportTarget, work: ContainerWork, options: HandOverContainerOptions): void {
  const { origins, platform, report } = options;
  // A note the local pass could not read has no local row yet, so its global copy stays until it does.
  const unread = new Set(work.container.skipped);
  const mirror: MemoryEntry[] = [];
  const purge: string[] = [];
  target.inContainer('hand_over_container', false, (tx) => {
    for (const origin of origins) {
      const prefix = containerPrefix(
        work.tool.id,
        containerId(work.container.path, work.container.scope, platform, origin),
      );
      for (const row of tx.liveBySourcePrefix(target.tenantId, prefix)) {
        if (!row.tags.includes(work.tool.tag) || unread.has(splitSource(row.source, prefix).key)) continue;
        const result = tx.setAside(work.tool.tag, row, 'handover');
        if (result.kind === 'untagged') mirror.push(result.entry);
        else purge.push(result.id);
      }
    }
  });
  toolReport(report, work.tool.id).tally.handedOver += mirror.length + purge.length;
  afterCommit(target, { mirror, purge }, report);
}

function toolOf(id: ToolId): AgentMemoryTool {
  const tool = AGENT_MEMORY_TOOLS.find((t) => t.id === id);
  if (tool === undefined) throw new Error(`agent memory sync: no tool ${id}`);
  return tool;
}
