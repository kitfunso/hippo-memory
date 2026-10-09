// `hippo projects`: list the project names a store holds, fold one into another, and repair old tags in one reversible pass.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setAsideRow } from './agent-memories/apply.js';
import { transcriptNotesProject } from './agent-memories/claude-code.js';
import { containerId, containerPrefix } from './agent-memories/source.js';
import { AGENT_MEMORY_SOURCE_PREFIX, AGENT_MEMORY_TOOLS, toolSourcePrefix } from './core/agent-memory-tools.js';
import { appendAuditEvent, queryAuditEvents } from './store/audit.js';
import { isSharedStore } from './config.js';
import { withTrialScope, withWriteScope, type DatabaseSyncLike } from './db.js';
import { withBackup } from './db/backup.js';
import { getMeta, setMeta } from './db/meta.js';
import { insertDormantRow, listDormantSnapshots, replaceDormantEntry } from './store/dormant.js';
import { processEnv } from './env.js';
import { calculateStrength, type MemoryEntry } from './memory.js';
import { isObjectLike, isStringValue } from './capture-contract.js';
import { isGlobalStoreRoot, projectNames, resolveProjectIdentity } from './project-identity.js';
import { duplicateKey } from './same-text.js';
import { compactionOriginsWithCwd, compactionTranscripts, holdsOrigin, restampCompactionOrigin } from './store/compactions.js';
import { removeEntryMirrors } from './store/mirrors.js';
import { deleteEntryRowInTx, restampOriginProjectAt, stampOriginProjectsAt, writeEntryMirrors } from './store/entry-writes.js';
import { selectAllEntries, selectLiveEntriesBySourcePrefix } from './store/entry-reads.js';
import type { JsonValue } from './json.js';

export interface ProjectSummary {
  /** '' is user-global, null is unknown; neither can be merged. */
  readonly origin: string | null;
  readonly live: number;
  readonly imported: number;
  readonly newest: string;
  /** Imported notes whose text another project name also holds: evidence of a duplicate import, never a merge target. */
  readonly copiesElsewhere: number;
}

export interface MergeResult {
  readonly from: string;
  readonly into: string;
  /** Imports `into` already holds for the same note, moved to dormant storage; the rest are re-tagged and the next sync files them under `into`. */
  readonly setAside: readonly string[];
  readonly restamped: readonly string[];
  readonly dormantRestamped: readonly string[];
  readonly compactions: number;
  readonly backup: string | null;
}

export interface ProjectFold {
  readonly from: string;
  readonly into: string;
}

/** An old name whose session folders now resolve to several projects: no fold can say whose rows are whose. */
export interface ProjectCollision {
  readonly name: string;
  readonly ids: readonly string[];
}

export interface RepairResult {
  /** Imported notes filed under the wrong project, or under a project name when a user-global import holds the same text: set aside. */
  readonly copies: readonly string[];
  /** Names whose recorded session folders all resolve to one other project today, folded as `merge` would. */
  readonly folds: readonly ProjectFold[];
  /** Names left unfolded because their folders now resolve to more than one project; only `merge` by hand can split them. */
  readonly collisions: readonly ProjectCollision[];
  readonly toProject: ReadonlyArray<{ readonly id: string; readonly origin: string }>;
  /** Parents in two projects: the merged text blends them, so it goes dormant and the parents re-merge per project. */
  readonly setAside: readonly string[];
  /** No parent left to say which project, or pinned: left as they are, since hiding them would rest on no evidence. */
  readonly untraced: readonly string[];
  readonly backup: string | null;
}

const ACTOR = 'cli';

function isImport(entry: MemoryEntry): boolean {
  return entry.source.startsWith(AGENT_MEMORY_SOURCE_PREFIX);
}

function toolTag(source: string): string | null {
  const id = source.slice(AGENT_MEMORY_SOURCE_PREFIX.length).split(':')[0];
  return AGENT_MEMORY_TOOLS.find((t) => t.id === id)?.tag ?? null;
}

/** Live rows per project name, newest write first, with how many of its imported notes are copies held elsewhere. */
export function listProjects(db: DatabaseSyncLike, tenantId: string): ProjectSummary[] {
  const live = selectAllEntries(db, tenantId).filter((e) => !e.superseded_by);
  const byOrigin = new Map<string | null, MemoryEntry[]>();
  const holders = new Map<string, Set<string | null>>();
  for (const e of live) {
    const origin = e.origin_project ?? null;
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), e]);
    const key = duplicateKey(e.content);
    if (isImport(e)) holders.set(key, (holders.get(key) ?? new Set<string | null>()).add(origin));
  }
  return [...byOrigin].map(([origin, rows]) => {
    const imports = rows.filter(isImport);
    return {
      origin,
      live: rows.length,
      imported: imports.length,
      newest: rows.reduce((max, e) => (e.created > max ? e.created : max), ''),
      copiesElsewhere: imports.filter((e) => (holders.get(duplicateKey(e.content))?.size ?? 0) > 1).length,
    };
  }).sort((a, b) => b.newest.localeCompare(a.newest));
}

function inTransaction<T>(db: DatabaseSyncLike, dryRun: boolean, body: () => T): T {
  return dryRun ? withTrialScope(db, 'merge_projects', body) : withWriteScope(db, 'merge_projects', body);
}

/** Refuses user-global and unknown: they are not projects, and folding them would leak or hide every row. */
export function validateMergeNames(from: string, into: string): string | null {
  if (from.trim() === '' || into.trim() === '') return 'both project names are required; user-global and unknown rows cannot be merged';
  if (from === into) return `${from} is already ${into}`;
  return null;
}

/** Folds project `from` into `into` for one tenant in one transaction; a dry run rolls back and writes nothing, mirrors included. */
export function mergeProjects(
  db: DatabaseSyncLike, hippoRoot: string, opts: { tenantId: string; from: string; into: string; dryRun: boolean },
): MergeResult {
  const refusal = validateMergeNames(opts.from, opts.into);
  if (refusal) throw new Error(refusal);
  const { tenantId, from, into, dryRun } = opts;
  const fold = (backup: string | null): MergeResult => inTransaction(db, dryRun, () => {
    const folded = foldInTx(db, tenantId, from, into);
    appendAuditEvent(db, { tenantId, actor: ACTOR, op: 'project_merge', metadata: { from, into, backup, ...folded } });
    return { from, into, ...folded, backup };
  });
  const result = dryRun ? fold(null) : withBackup(db, hippoRoot, 'before-merge', fold);
  if (!dryRun) refreshMirrors(db, hippoRoot, tenantId, result.restamped, result.setAside);
  return result;
}

function foldInTx(db: DatabaseSyncLike, tenantId: string, from: string, into: string): Omit<MergeResult, 'from' | 'into' | 'backup'> {
  const all = selectAllEntries(db, tenantId);
  const rows = all.filter((e) => e.origin_project === from);
  // The sync renames the rest to `into`'s prefix and keeps their ids; only a note `into` already holds would show twice.
  const held = new Set(all.filter((e) => e.origin_project === into && !e.superseded_by && isImport(e)).map(noteKey));
  const setAside: string[] = [];
  for (const row of rows) {
    const tag = toolTag(row.source);
    if (!isImport(row) || row.superseded_by || row.kind === 'raw' || tag === null || !held.has(noteKey(row))) continue;
    if (setAsideRow(db, tag, { ...row, origin_project: into }, 'project-merge').kind === 'dormant') setAside.push(row.id);
  }
  const gone = new Set(setAside);
  const restamped = rows.filter((e) => !gone.has(e.id)).map((e) => e.id);
  restampOriginProjectAt(db, tenantId, from, into);
  const dormantRestamped: string[] = [];
  for (const snap of listDormantSnapshots(db, tenantId)) {
    if (snap.entry.origin_project !== from || gone.has(snap.entry.id)) continue;
    replaceDormantEntry(db, tenantId, snap.entry.id, { ...snap.entry, origin_project: into });
    dormantRestamped.push(snap.entry.id);
  }
  const compactions = restampCompactionOrigin(db, tenantId, from, into);
  return { setAside, restamped, dormantRestamped, compactions };
}

/** Tool, note key and hash of an import, without the container, whose id hashes the project name. */
function noteKey(entry: MemoryEntry): string {
  const rest = entry.source.slice(AGENT_MEMORY_SOURCE_PREFIX.length);
  return `${rest.split(':')[0]}:${rest.slice(rest.indexOf('/') + 1)}`;
}

/** Live imports under a project name whose exact text a user-global import holds: a session folder's notes stamped with the folder it ended in. */
function importCopies(db: DatabaseSyncLike, tenantId: string): MemoryEntry[] {
  const live = selectAllEntries(db, tenantId).filter((e) => !e.superseded_by && isImport(e));
  const userGlobal = new Set(live.filter((e) => e.origin_project === '').map((e) => duplicateKey(e.content)));
  return live.filter((e) => e.origin_project && e.kind !== 'raw' && !e.pinned && toolTag(e.source) !== null && userGlobal.has(duplicateKey(e.content)));
}

/** Imports to set aside. The global store also checks each Claude session folder a compaction recorded: its notes under any other project are misfiled, edited or not, and a text copy in the right folder is kept. */
function strayImports(db: DatabaseSyncLike, hippoRoot: string, tenantId: string): MemoryEntry[] {
  const copies = importCopies(db, tenantId);
  if (!isGlobalStoreRoot(hippoRoot)) return copies;
  const machine = { platform: process.platform, env: processEnv() };
  const { platform } = machine;
  const sessions = compactionTranscripts(db, tenantId);
  const owners = new Map<string, Map<string, string[]>>();
  for (const { transcript, cwd } of sessions) {
    const project = transcriptNotesProject(transcript, cwd, machine);
    const dir = path.join(path.dirname(transcript), 'memory');
    if (project === null) continue;
    const ids = owners.get(dir) ?? new Map<string, string[]>();
    owners.set(dir, ids.set(project.name, [...new Set([...(ids.get(project.name) ?? []), ...projectNames(project)])]));
  }
  const tool = toolSourcePrefix('claude-code');
  const live = selectLiveEntriesBySourcePrefix(db, tenantId, tool).filter((e) => e.kind !== 'raw' && !e.pinned);
  const origins = new Set(live.map((e) => e.origin_project ?? ''));
  const edges = foldEdges(db, tenantId);
  const right = new Set<string>();
  const wrong = new Set<string>();
  for (const [dir, ids] of owners) {
    if (ids.size !== 1) continue;
    // Its names before the id, and names folded into it, are the owner's too: the next sync moves those prefixes under the id.
    const [names] = ids.values();
    const own = new Set([...names, ...foldedInto(edges, names)]);
    for (const origin of new Set([...origins, ...own])) (own.has(origin) ? right : wrong).add(containerPrefix('claude-code', containerId(dir, 'project', platform, origin)));
  }
  const prefix = (e: MemoryEntry) => e.source.slice(0, e.source.indexOf('/', tool.length) + 1);
  const misfiled = live.filter((e) => wrong.has(prefix(e)));
  const seen = new Set(misfiled.map((e) => e.id));
  return [...misfiled, ...copies.filter((e) => !seen.has(e.id) && !right.has(prefix(e)))];
}

/** The global store reads each name's recorded session folders, where a compaction's name came from its cwd; a project store folds only its own folder name. */
function planFolds(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, globalFolds: boolean): Pick<RepairResult, 'folds' | 'collisions'> {
  // A name someone merged into by hand stays: undoing their choice would rest on the resolver alone.
  const chosen = new Set(queryAuditEvents(db, { tenantId, op: 'project_merge', limit: 10000 }).map((e) => e.metadata.into));
  if (!isGlobalStoreRoot(hippoRoot)) return { folds: ownLegacyFold(db, hippoRoot, tenantId).filter((f) => !chosen.has(f.from)), collisions: [] };
  const rows = compactionOriginsWithCwd(db, tenantId);
  const today = new Map<string, Set<string>>();
  for (const { origin, cwd } of rows) {
    if (fs.existsSync(cwd)) today.set(origin, (today.get(origin) ?? new Set<string>()).add(resolveProjectIdentity(cwd).name));
  }
  const folds: ProjectFold[] = [];
  const collisions: ProjectCollision[] = [];
  for (const [from, names] of today) {
    const [into] = names;
    if (chosen.has(from)) continue;
    if (names.size > 1) collisions.push({ name: from, ids: [...names].sort() });
    else if (into !== '' && into !== from) folds.push({ from, into });
  }
  // A fold into a name that itself folds would land rows by run order; the next repair takes the rest of the chain.
  const sources = new Set(folds.map((f) => f.from));
  return { folds: globalFolds ? folds.filter((f) => !sources.has(f.into)) : [], collisions };
}

/** A project store's rows, dormant snapshots and compaction records written before its id existed carry its folder name. */
function ownLegacyFold(db: DatabaseSyncLike, hippoRoot: string, tenantId: string): ProjectFold[] {
  // A shared store's rows carry their callers' names, so one matching its folder's is a member's project, not a legacy tag.
  if (isSharedStore(hippoRoot)) return [];
  const { name, legacyName } = resolveProjectIdentity(path.dirname(path.resolve(hippoRoot)));
  if (legacyName === '' || legacyName === name) return [];
  const held = holdsOrigin(db, 'memories', tenantId, legacyName) || holdsOrigin(db, 'compactions', tenantId, legacyName) || listDormantSnapshots(db, tenantId).some((s) => s.entry.origin_project === legacyName);
  return held ? [{ from: legacyName, into: name }] : [];
}

function foldOf(value: JsonValue | undefined): ProjectFold[] {
  if (!isObjectLike(value) || Array.isArray(value)) return [];
  const { from, into } = value;
  return isStringValue(from) && isStringValue(into) ? [{ from, into }] : [];
}

function foldEdges(db: DatabaseSyncLike, tenantId: string): ProjectFold[] {
  return [
    ...queryAuditEvents(db, { tenantId, op: 'project_merge', limit: 10000 }).flatMap((e) => foldOf(e.metadata)),
    ...queryAuditEvents(db, { tenantId, op: 'project_repair', limit: 10000 })
      .flatMap((e) => (Array.isArray(e.metadata.folds) ? e.metadata.folds.flatMap(foldOf) : [])),
  ];
}

function foldedInto(edges: readonly ProjectFold[], names: readonly string[]): string[] {
  const seen = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { from, into } of edges) {
      if (!seen.has(into) || seen.has(from)) continue;
      seen.add(from);
      grew = true;
    }
  }
  return [...seen].filter((n) => !names.includes(n));
}

/** Names folded, directly or through others, into one of `names`; the sync moves imports still filed under them. */
export function namesFoldedInto(db: DatabaseSyncLike, tenantId: string, names: readonly string[]): string[] {
  return foldedInto(foldEdges(db, tenantId), names);
}

/** Reads only, so doctor and a dry run take no write lock; merged rows are planned before any fold, so a few may re-tag differently once folds apply. */
export function planProjectRepair(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, globalFolds = true): Omit<RepairResult, 'backup'> {
  const { folds, collisions } = planFolds(db, hippoRoot, tenantId, globalFolds);
  return { copies: strayImports(db, hippoRoot, tenantId).map((e) => e.id), folds, collisions, ...planUserGlobalRepair(db, tenantId, folds) };
}

/** Parents read with `folds` already applied, so a plan matches what apply does after folding. */
function planUserGlobalRepair(db: DatabaseSyncLike, tenantId: string, folds: readonly ProjectFold[]): Pick<RepairResult, 'toProject' | 'setAside' | 'untraced'> {
  const all = selectAllEntries(db, tenantId);
  const renamed = new Map(folds.map((f) => [f.from, f.into]));
  const after = (origin: string | null | undefined) => (origin ? renamed.get(origin) ?? origin : origin ?? null);
  const origins = new Map<string, string | null>(listDormantSnapshots(db, tenantId).map((s) => [s.entry.id, after(s.entry.origin_project)]));
  for (const e of all) origins.set(e.id, after(e.origin_project));
  const toProject: Array<{ id: string; origin: string }> = [];
  const setAside: string[] = [];
  const untraced: string[] = [];
  for (const row of all) {
    if (row.source !== 'consolidation' || row.origin_project !== '' || row.superseded_by) continue;
    const parents = new Set(row.parents.filter((id) => origins.has(id)).map((id) => origins.get(id) ?? null));
    const [only] = parents;
    if (parents.size === 1 && only === '') continue;
    if (parents.size === 1 && only) toProject.push({ id: row.id, origin: only });
    else if (parents.size > 1 && !row.pinned && row.kind !== 'raw') setAside.push(row.id);
    else untraced.push(row.id);
  }
  return { toProject, setAside, untraced };
}

/** Sets aside stray imports, folds the names the resolver now maps elsewhere, then re-tags sleep's user-global merges by their parents; a dry run only plans. */
export function repairProjects(
  db: DatabaseSyncLike, hippoRoot: string, opts: { tenantId: string; dryRun: boolean; globalFolds?: boolean },
): RepairResult {
  const { tenantId, dryRun, globalFolds = true } = opts;
  if (dryRun) return { ...planProjectRepair(db, hippoRoot, tenantId, globalFolds), backup: null };
  const { result, rewrite, purge } = withBackup(db, hippoRoot, 'before-repair', (backup) => inTransaction(db, false, () => {
    const copies: string[] = [];
    for (const row of strayImports(db, hippoRoot, tenantId)) {
      const tag = toolTag(row.source);
      if (tag !== null && setAsideRow(db, tag, row, 'project-repair').kind === 'dormant') copies.push(row.id);
    }
    const { folds, collisions } = planFolds(db, hippoRoot, tenantId, globalFolds);
    const folded = folds.map((f) => foldInTx(db, tenantId, f.from, f.into));
    const plan = planUserGlobalRepair(db, tenantId, []);
    stampOriginProjectsAt(db, tenantId, plan.toProject);
    const aside = new Set(plan.setAside);
    const now = new Date();
    for (const row of selectAllEntries(db, tenantId).filter((e) => aside.has(e.id))) {
      insertDormantRow(db, { entry: row, strength: calculateStrength(row, now), reason: 'project-repair', dormantAt: now.toISOString() });
      deleteEntryRowInTx(db, row, ACTOR);
    }
    appendAuditEvent(db, { tenantId, actor: ACTOR, op: 'project_repair', metadata: { backup, copies, folds, folded, ...plan } });
    return {
      result: { copies, folds, collisions, ...plan, backup },
      rewrite: [...plan.toProject.map((r) => r.id), ...folded.flatMap((f) => f.restamped)],
      purge: [...copies, ...plan.setAside, ...folded.flatMap((f) => f.setAside)],
    };
  }));
  refreshMirrors(db, hippoRoot, tenantId, rewrite, purge);
  return result;
}

const AUTO_REPAIR_META_KEY = 'project_repair_auto';

/** True when a repair would change nothing. */
function repairIsEmpty(r: Omit<RepairResult, 'backup'>): boolean {
  return r.copies.length + r.folds.length + r.toProject.length + r.setAside.length === 0;
}

/**
 * Sleep runs repair once per store, so an upgrade needs no command. Global-store folds stay
 * with `hippo projects repair`: their evidence is compaction folders, blind to a same-named repo that never compacted.
 */
export function repairOnceOnSleep(db: DatabaseSyncLike, hippoRoot: string, tenantId: string): RepairResult | null {
  if (getMeta(db, AUTO_REPAIR_META_KEY) === '1') return null;
  const plan = planProjectRepair(db, hippoRoot, tenantId, false);
  const result = repairIsEmpty(plan) ? null : repairProjects(db, hippoRoot, { tenantId, dryRun: false, globalFolds: false });
  setMeta(db, AUTO_REPAIR_META_KEY, '1');
  return result;
}

/** After commit, as the agent memory sync does: a stale mirror would bring the old tag back on the next rebuild. */
function refreshMirrors(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, rewrite: readonly string[], purge: readonly string[]): void {
  const ids = new Set(rewrite);
  for (const entry of selectAllEntries(db, tenantId)) if (ids.has(entry.id)) writeEntryMirrors(hippoRoot, entry);
  for (const id of purge) removeEntryMirrors(hippoRoot, id);
}
