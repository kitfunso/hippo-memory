// Runs the adapters and routes each container to its store: the project pass, the user pass and their call sites (plan designs 2, 8, 11).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errorMessage } from '../log.js';
import { loadConfig } from '../config.js';
import { closeHippoDb, isSqliteBusy, openHippoDb, type DatabaseSyncLike } from '../db.js';
import type { MemoryEntry } from '../memory.js';
import { deriveOriginProject, isGlobalStoreRoot, resolveGlobalRootDir } from '../project-identity.js';
import { duplicateKey, heldTextKeys } from '../same-text.js';
import { initStore, isInitialized, removeEntryMirrors, selectLiveEntriesBySourcePrefix, updateStats, writeEntryMirrors } from '../store.js';
import { resolveTenantId } from '../tenant.js';
import { setAsideRow, syncContainer, type ContainerOutcome, type ContainerWork, type StoreSession } from './apply.js';
import { claudeCodeAdapter, claudeTranscriptListing } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { geminiAdapter } from './gemini.js';
import { legacyWork, type LegacyWork } from './legacy.js';
import { openclawAdapter } from './openclaw.js';
import { qwenCodeAdapter } from './qwen-code.js';
import { addTally, emptyReport, mergeReports, toolReport, type ImportReport, type ToolReport } from './report.js';
import { containerId, containerPrefix, splitSource } from './source.js';
import { AGENT_MEMORY_SOURCE_PREFIX, AGENT_MEMORY_TOOLS, isToolId, toolSourcePrefix, type AgentMemoryTool, type ToolId } from './tools.js';
import type { Adapter, AdapterContext, Listing, Scope } from './types.js';

export const ADAPTERS: readonly Adapter[] = [claudeCodeAdapter, codexAdapter, geminiAdapter, copilotAdapter, openclawAdapter, qwenCodeAdapter];

/** Overrides config because `hippo init` creates the store in the same command that imports (plan design 11). */
export const TOOLS_ENV = 'HIPPO_AGENT_MEMORY_TOOLS';

/** Everything the adapters may know about the machine; tests hand in a scratch one. */
export interface Machine {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}

export function currentMachine(): Machine {
  return { home: os.homedir(), env: process.env, platform: process.platform };
}

export interface SyncOptions {
  readonly machine: Machine;
  /** Writes nothing: each container's transaction rolls back, and a missing store is stood in for by an empty one. */
  readonly dryRun?: boolean;
  /** How long a busy store is waited on before its containers are skipped. */
  readonly busyWaitMs?: number;
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
  /** Set aside the global store's copies of each container this pass syncs into a local store. */
  readonly handover: boolean;
}

/** init, sleep, `import --agents` and the daily runner: a local store gets its project pass then the user pass; the global store the user pass only. */
export function importForStore(hippoRoot: string, opts: SyncOptions): ImportReport {
  if (isGlobalStoreRoot(hippoRoot)) return importUserMemories(hippoRoot, opts);
  const report = importProjectMemories(hippoRoot, opts);
  mergeReports(report, importUserMemories(hippoRoot, opts));
  return report;
}

/** A local store's project pass with legacy adoption; `init --scan` runs it per repository and the user pass once. */
export function importProjectMemories(hippoRoot: string, opts: SyncOptions): ImportReport {
  const ctx = context(opts.machine, { projectRoot: path.dirname(hippoRoot) });
  return runPass({
    scope: 'project', target: hippoRoot, invoking: hippoRoot, list: (a) => a.list(ctx, 'project'), legacy: true, originProject: undefined, handover: true,
  }, opts);
}

/** Every tool's user-level memory into the global store, created on demand, with no origin. */
export function importUserMemories(invokingRoot: string, opts: SyncOptions): ImportReport {
  const ctx = context(opts.machine, {});
  return runPass({
    scope: 'user', target: resolveGlobalRootDir(), invoking: invokingRoot, list: (a) => a.list(ctx, 'user'), legacy: false, originProject: '', handover: false,
  }, opts);
}

/** Session end in a folder with no store of its own: the session's project into the global store with its origin, then the user pass. */
export function importAtSessionEnd(cwd: string, transcriptPath: string | undefined, opts: SyncOptions): ImportReport {
  const globalRoot = resolveGlobalRootDir();
  const ctx = context(opts.machine, { projectRoot: cwd, transcriptPath });
  const report = runPass({
    scope: 'project', target: globalRoot, invoking: globalRoot, list: (a) => a.list(ctx, 'project'), legacy: false, originProject: deriveOriginProject(cwd), handover: false,
  }, opts);
  mergeReports(report, importUserMemories(globalRoot, opts));
  return report;
}

/** Post-compact: the transcript folder's notes only, with no git call, no legacy adoption and no user pass, as the hook has 10 seconds. */
export function importAtCompaction(hippoRoot: string, transcriptPath: string, originProject: string | undefined, opts: SyncOptions): ImportReport {
  const ctx = context(opts.machine, {});
  return runPass({
    scope: 'project', target: hippoRoot, invoking: hippoRoot, legacy: false, originProject, handover: false,
    list: (a) => (a.tool === 'claude-code' ? claudeTranscriptListing(ctx, transcriptPath) : null),
  }, opts);
}

function context(machine: Machine, extra: Pick<AdapterContext, 'projectRoot' | 'transcriptPath'>): AdapterContext {
  return { home: machine.home, env: machine.env, platform: machine.platform, ...extra };
}

/** The variable when set (empty or `none` is off); else the tools both the invoking and the target store's config allow. */
export function allowedTools(env: Machine['env'], invoking: string, target: string, warnings: string[]): Set<ToolId> {
  const fromEnv = env[TOOLS_ENV];
  if (fromEnv !== undefined) {
    const listed = fromEnv.trim().toLowerCase() === 'none' ? [] : fromEnv.split(',').map((t) => t.trim()).filter((t) => t !== '');
    return knownTools(listed, TOOLS_ENV, warnings);
  }
  const mine = configuredTools(invoking, warnings);
  const theirs = configuredTools(target, warnings);
  return new Set(AGENT_MEMORY_TOOLS.map((t) => t.id).filter((id) => (mine === null || mine.has(id)) && (theirs === null || theirs.has(id))));
}

function configuredTools(root: string, warnings: string[]): Set<ToolId> | null {
  const tools = loadConfig(root).agentMemories.tools;
  return tools === null ? null : knownTools(tools, 'config agentMemories.tools', warnings);
}

function knownTools(ids: readonly string[], where: string, warnings: string[]): Set<ToolId> {
  const out = new Set<ToolId>();
  for (const id of ids) {
    if (isToolId(id)) out.add(id);
    else warnings.push(`${where}: unknown agent memory tool "${id}" ignored (known: ${AGENT_MEMORY_TOOLS.map((t) => t.id).join(', ')})`);
  }
  return out;
}

function runPass(pass: Pass, opts: SyncOptions): ImportReport {
  const report = emptyReport();
  const allowed = allowedTools(opts.machine.env, pass.invoking, pass.target, report.warnings);
  const listings = ADAPTERS.filter((a) => allowed.has(a.tool)).flatMap((a) => listSafely(a, pass, report));
  const hasItems = listings.some((l) => l.containers.some((c) => c.items.length > 0));
  let store: OpenStore | null = null;
  let synced: ContainerWork[] = [];
  try {
    store = openTarget(pass.target, hasItems, opts);
    if (store !== null) synced = syncStore(pass, listings, store, opts, report);
  } catch (err) {
    report.warnings.push(`agent memories not synced into ${pass.target}: ${isSqliteBusy(err) ? 'the store was busy' : errorMessage(err)}`);
  } finally {
    store?.close();
  }
  if (pass.handover && !opts.dryRun) handOver(synced, path.dirname(pass.target), opts, report);
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
    tool.containers.push({ scope: c.scope, path: c.path, store: pass.target, items: c.items.length, readable: c.readable });
    report.warnings.push(...c.warnings.map((w) => `${tool.label}: ${w}`));
  }
  return [listing];
}

interface OpenStore {
  readonly db: DatabaseSyncLike;
  readonly root: string;
  readonly global: boolean;
  close(): void;
}

/** A store that does not exist yet is created only when there is something to put in it; a dry run plans against an empty stand-in. */
function openTarget(target: string, hasItems: boolean, opts: SyncOptions): OpenStore | null {
  const global = isGlobalStoreRoot(target);
  if (!isInitialized(target)) {
    if (opts.dryRun) return emptyStandIn(global);
    if (!hasItems) return null;
    initStore(target);
  }
  const db = openHippoDb(target, { busyWaitMs: opts.busyWaitMs });
  return { db, root: target, global, close: () => closeHippoDb(db) };
}

function emptyStandIn(global: boolean): OpenStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-agent-memories-'));
  const db = openHippoDb(root);
  return {
    db, root, global,
    close: () => {
      closeHippoDb(db);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function syncStore(pass: Pass, listings: readonly Listing[], store: OpenStore, opts: SyncOptions, report: ImportReport): ContainerWork[] {
  const tenantId = resolveTenantId({});
  const legacy = pass.legacy ? legacyWork(store.db, tenantId, listings) : null;
  const session: StoreSession = {
    db: store.db,
    hippoRoot: store.root,
    tenantId,
    baseHalfLifeDays: loadConfig(store.root).defaultHalfLifeDays,
    originProject: pass.originProject,
    isDuplicate: duplicateCheck(store, tenantId, pass.originProject, legacy?.adopted ?? new Set()),
    dryRun: opts.dryRun === true,
  };
  // A project's rows in the global store are parted by origin: a worktree and its main checkout share a Claude folder.
  const partition = store.global && pass.scope === 'project' ? pass.originProject ?? '' : null;
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
      const work = containerWork(tool, container, opts.machine.platform, legacy, partition ?? '');
      const outcome = syncOne(session, work, out, report);
      if (outcome === null) continue;
      synced.push(work);
      remembered += outcome.tally.imported + outcome.tally.replaced;
      if (!session.dryRun) afterCommit(store.root, outcome, report);
    }
    if (session.dryRun) out.unlisted += unlistedRows(store.db, tenantId, tool, pass.scope, listing, opts.machine.platform, partition);
  }
  if (remembered > 0 && !session.dryRun) bumpRemembered(store.root, remembered, report);
  return synced;
}

function containerWork(
  tool: AgentMemoryTool, container: ContainerWork['container'], platform: NodeJS.Platform, legacy: LegacyWork | null, origin: string,
): ContainerWork {
  const none = new Map<string, readonly MemoryEntry[]>();
  const own = tool.id === 'claude-code' ? legacy?.byContainer.get(container.path) : undefined;
  return {
    tool,
    container,
    prefix: containerPrefix(tool.id, containerId(container.path, container.scope, platform, origin)),
    adopt: own?.adopt ?? none,
    replace: own?.replace ?? none,
  };
}

/** Null when the container was skipped: a busy store waits for the next sync, any other failure is a warning and the sync goes on. */
function syncOne(session: StoreSession, work: ContainerWork, out: ToolReport, report: ImportReport): ContainerOutcome | null {
  try {
    const outcome = syncContainer(session, work);
    addTally(out.tally, outcome.tally);
    return outcome;
  } catch (err) {
    if (isSqliteBusy(err)) {
      out.tally.busy++;
      report.warnings.push(`${out.label}: ${work.container.path} skipped, the store was busy`);
    } else {
      report.warnings.push(`${out.label}: ${work.container.path} not synced: ${errorMessage(err)}`);
    }
    return null;
  }
}

function afterCommit(root: string, outcome: Pick<ContainerOutcome, 'mirror' | 'purge'>, report: ImportReport): void {
  for (const entry of outcome.mirror) writeEntryMirrors(root, entry);
  for (const id of outcome.purge) {
    try {
      removeEntryMirrors(root, id);
    } catch (err) {
      // rebuildIndex would bring the row back live, and the next sync sets it aside again.
      report.warnings.push(`mirror of ${id} not removed: ${errorMessage(err)}`);
    }
  }
}

function bumpRemembered(root: string, remembered: number, report: ImportReport): void {
  try {
    updateStats(root, { remembered });
  } catch (err) {
    report.warnings.push(`remembered counter not updated: ${errorMessage(err)}`);
  }
}

/** Design 6: only text stored by another path counts, and in the global store only rows visible where the new row goes. */
function duplicateCheck(store: OpenStore, tenantId: string, origin: string | undefined, adopted: ReadonlySet<string>): (text: string) => boolean {
  let keys: Set<string> | null = null;
  return (text) => {
    keys ??= otherPathKeys(store, tenantId, origin ?? '', adopted);
    return keys.has(duplicateKey(text));
  };
}

function otherPathKeys(store: OpenStore, tenantId: string, origin: string, adopted: ReadonlySet<string>): Set<string> {
  const visible = store.global ? ` AND (origin_project = '' OR origin_project = ?)` : '';
  const params = store.global ? [tenantId, AGENT_MEMORY_SOURCE_PREFIX, origin] : [tenantId, AGENT_MEMORY_SOURCE_PREFIX];
  // SAFETY: the SELECT names the three columns of the row type.
  const rows = store.db.prepare(
    `SELECT id, content, source FROM memories
      WHERE tenant_id = ? AND superseded_by IS NULL AND substr(source, 1, ${AGENT_MEMORY_SOURCE_PREFIX.length}) != ?${visible}`,
  ).all(...params) as Array<{ id: string; content: string; source: string }>;
  return new Set(rows.filter((r) => !adopted.has(r.id)).flatMap(heldTextKeys));
}

/** Dry run only: kept rows of this scope in containers this run did not list (a moved project's old folder); `partition` limits it to one origin. */
function unlistedRows(
  db: DatabaseSyncLike, tenantId: string, tool: AgentMemoryTool, scope: Scope, listing: Listing, platform: NodeJS.Platform, partition: string | null,
): number {
  const listed = listing.containers.map((c) => containerPrefix(tool.id, containerId(c.path, c.scope, platform, partition ?? '')));
  return selectLiveEntriesBySourcePrefix(db, tenantId, `${toolSourcePrefix(tool.id)}${scope === 'project' ? 'p' : 'u'}-`)
    .filter((row) => row.tags.includes(tool.tag) && !listed.some((p) => row.source.startsWith(p)))
    .filter((row) => partition === null || (row.origin_project ?? '') === partition).length;
}

/** Design 2's handover: rows the store-less hook path left in the global store, under this project's origin, for containers its store now syncs. */
function handOver(synced: readonly ContainerWork[], projectRoot: string, opts: SyncOptions, report: ImportReport): void {
  const globalRoot = resolveGlobalRootDir();
  if (synced.length === 0 || !isInitialized(globalRoot)) return;
  let db: DatabaseSyncLike | undefined;
  try {
    db = openHippoDb(globalRoot, { busyWaitMs: opts.busyWaitMs });
    const tenantId = resolveTenantId({});
    // A folder with no git and no marker wrote as '' before its store existed, and as its own name after.
    const origins = [...new Set([deriveOriginProject(projectRoot), ''])];
    for (const work of synced) handOverContainer(db, globalRoot, tenantId, work, origins, opts.machine.platform, report);
  } catch (err) {
    report.warnings.push(`global copies not handed over: ${isSqliteBusy(err) ? 'the global store was busy' : errorMessage(err)}`);
  } finally {
    if (db) closeHippoDb(db);
  }
}

function handOverContainer(
  db: DatabaseSyncLike, root: string, tenantId: string, work: ContainerWork, origins: readonly string[], platform: NodeJS.Platform, report: ImportReport,
): void {
  // A note the local pass could not read has no local row yet, so its global copy stays until it does.
  const unread = new Set(work.container.skipped);
  const mirror: MemoryEntry[] = [];
  const purge: string[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const origin of origins) {
      const prefix = containerPrefix(work.tool.id, containerId(work.container.path, work.container.scope, platform, origin));
      for (const row of selectLiveEntriesBySourcePrefix(db, tenantId, prefix)) {
        if (!row.tags.includes(work.tool.tag) || unread.has(splitSource(row.source, prefix).key)) continue;
        const result = setAsideRow(db, work.tool.tag, row, 'handover');
        if (result.kind === 'untagged') mirror.push(result.entry);
        else purge.push(result.id);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back; keep the original error */ }
    throw err;
  }
  toolReport(report, work.tool.id).tally.handedOver += mirror.length + purge.length;
  afterCommit(root, { mirror, purge }, report);
}

function toolOf(id: ToolId): AgentMemoryTool {
  const tool = AGENT_MEMORY_TOOLS.find((t) => t.id === id);
  if (tool === undefined) throw new Error(`agent memory sync: no tool ${id}`);
  return tool;
}
