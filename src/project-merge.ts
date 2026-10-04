// `hippo projects`: list the project names a store holds, fold one into another, and repair old tags in one reversible pass.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setAsideRow } from './agent-memories/apply.js';
import { transcriptNotesOrigin } from './agent-memories/claude-code.js';
import { containerId, containerPrefix } from './agent-memories/source.js';
import { AGENT_MEMORY_SOURCE_PREFIX, AGENT_MEMORY_TOOLS, toolSourcePrefix } from './agent-memories/tools.js';
import { appendAuditEvent, queryAuditEvents } from './audit.js';
import type { DatabaseSyncLike } from './db.js';
import { insertDormantRow, listDormantSnapshots, replaceDormantEntry } from './dormant.js';
import { processEnv } from './env.js';
import { calculateStrength, type MemoryEntry } from './memory.js';
import { deriveOriginProject, isGlobalStoreRoot } from './project-identity.js';
import { duplicateKey } from './same-text.js';
import { removeEntryMirrors } from './store/mirrors.js';
import { deleteEntryRowInTx, writeEntryMirrors } from './store/entry-writes.js';
import { selectAllEntries, selectLiveEntriesBySourcePrefix } from './store/entry-reads.js';

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
  /** Imported note copies moved to dormant storage; the next sync under `into` imports the notes still on disk. */
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

export interface RepairResult {
  /** Imported notes filed under the wrong project, or under a project name when a user-global import holds the same text: set aside. */
  readonly copies: readonly string[];
  /** Names whose recorded session folders all resolve to one other project today, folded as `merge` would. */
  readonly folds: readonly ProjectFold[];
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

/** Copies the database before a repair writes, so the audit ids plus this file are the way back. */
export function backupStore(db: DatabaseSyncLike, hippoRoot: string, label: string, now = new Date()): string {
  const dir = path.join(hippoRoot, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `hippo-${label}-${now.toISOString().replace(/[:.]/g, '-')}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  return file;
}

function inTransaction<T>(db: DatabaseSyncLike, dryRun: boolean, body: () => T): T {
  db.exec(dryRun ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    const out = body();
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back; keep the original error */ }
    throw err;
  }
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
  const backup = dryRun ? null : backupStore(db, hippoRoot, 'before-merge');
  const result = inTransaction(db, dryRun, () => {
    const folded = foldInTx(db, tenantId, from, into);
    appendAuditEvent(db, { tenantId, actor: ACTOR, op: 'project_merge', metadata: { from, into, backup, ...folded } });
    return { from, into, ...folded, backup };
  });
  if (!dryRun) refreshMirrors(db, hippoRoot, tenantId, result.restamped, result.setAside);
  return result;
}

function foldInTx(db: DatabaseSyncLike, tenantId: string, from: string, into: string): Omit<MergeResult, 'from' | 'into' | 'backup'> {
  const rows = selectAllEntries(db, tenantId).filter((e) => e.origin_project === from);
  const setAside: string[] = [];
  for (const row of rows) {
    const tag = toolTag(row.source);
    if (!isImport(row) || row.superseded_by || row.kind === 'raw' || tag === null) continue;
    if (setAsideRow(db, tag, { ...row, origin_project: into }, 'project-merge').kind === 'dormant') setAside.push(row.id);
  }
  const gone = new Set(setAside);
  const restamped = rows.filter((e) => !gone.has(e.id)).map((e) => e.id);
  db.prepare(`UPDATE memories SET origin_project = ?, updated_at = datetime('now') WHERE tenant_id = ? AND origin_project = ?`)
    .run(into, tenantId, from);
  const dormantRestamped: string[] = [];
  for (const snap of listDormantSnapshots(db, tenantId)) {
    if (snap.entry.origin_project !== from || gone.has(snap.entry.id)) continue;
    replaceDormantEntry(db, tenantId, snap.entry.id, { ...snap.entry, origin_project: into });
    dormantRestamped.push(snap.entry.id);
  }
  const compactions = Number(db.prepare(`UPDATE compactions SET origin_project = ? WHERE tenant_id = ? AND origin_project = ?`)
    .run(into, tenantId, from).changes ?? 0);
  return { setAside, restamped, dormantRestamped, compactions };
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
  // SAFETY: the SELECT names the two columns of the row type.
  const sessions = db.prepare(`SELECT DISTINCT transcript_path AS transcript, cwd FROM compactions WHERE tenant_id = ? AND transcript_path IS NOT NULL`)
    .all(tenantId) as Array<{ transcript: string; cwd: string | null }>;
  const owners = new Map<string, Set<string>>();
  for (const { transcript, cwd } of sessions) {
    const origin = transcriptNotesOrigin(transcript, cwd, machine);
    const dir = path.join(path.dirname(transcript), 'memory');
    if (origin !== null) owners.set(dir, (owners.get(dir) ?? new Set<string>()).add(origin));
  }
  const tool = toolSourcePrefix('claude-code');
  const live = selectLiveEntriesBySourcePrefix(db, tenantId, tool).filter((e) => e.kind !== 'raw' && !e.pinned);
  const origins = new Set(live.map((e) => e.origin_project ?? ''));
  const right = new Set<string>();
  const wrong = new Set<string>();
  for (const [dir, owner] of owners) {
    if (owner.size !== 1) continue;
    for (const origin of origins) (owner.has(origin) ? right : wrong).add(containerPrefix('claude-code', containerId(dir, 'project', platform, origin)));
  }
  const prefix = (e: MemoryEntry) => e.source.slice(0, e.source.indexOf('/', tool.length) + 1);
  const misfiled = live.filter((e) => wrong.has(prefix(e)));
  const seen = new Set(misfiled.map((e) => e.id));
  return [...misfiled, ...copies.filter((e) => !seen.has(e.id) && !right.has(prefix(e)))];
}

/** Global store only, where a compaction's name came from its cwd: a name whose every cwd still on disk resolves to one other project today. */
function planFolds(db: DatabaseSyncLike, tenantId: string): ProjectFold[] {
  // SAFETY: the SELECT names the two columns of the row type.
  const rows = db.prepare(`SELECT DISTINCT origin_project AS origin, cwd FROM compactions WHERE tenant_id = ? AND origin_project <> '' AND cwd IS NOT NULL`)
    .all(tenantId) as Array<{ origin: string; cwd: string }>;
  const today = new Map<string, Set<string>>();
  for (const { origin, cwd } of rows) {
    if (fs.existsSync(cwd)) today.set(origin, (today.get(origin) ?? new Set<string>()).add(deriveOriginProject(cwd)));
  }
  // A name someone merged into by hand stays: undoing their choice would rest on the resolver alone.
  const chosen = new Set(queryAuditEvents(db, { tenantId, op: 'project_merge', limit: 10000 }).map((e) => e.metadata.into));
  const folds = [...today].flatMap(([from, names]) => {
    const [into] = names;
    return names.size === 1 && into !== '' && into !== from && !chosen.has(from) ? [{ from, into }] : [];
  });
  // A fold into a name that itself folds would land rows by run order; the next repair takes the rest of the chain.
  const sources = new Set(folds.map((f) => f.from));
  return folds.filter((f) => !sources.has(f.into));
}

/** Reads only, so doctor and a dry run take no write lock; merged rows are planned before any fold, so a few may re-tag differently once folds apply. */
export function planProjectRepair(db: DatabaseSyncLike, hippoRoot: string, tenantId: string): Omit<RepairResult, 'backup'> {
  const folds = isGlobalStoreRoot(hippoRoot) ? planFolds(db, tenantId) : [];
  return { copies: strayImports(db, hippoRoot, tenantId).map((e) => e.id), folds, ...planUserGlobalRepair(db, tenantId, folds) };
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
  db: DatabaseSyncLike, hippoRoot: string, opts: { tenantId: string; dryRun: boolean },
): RepairResult {
  const { tenantId, dryRun } = opts;
  if (dryRun) return { ...planProjectRepair(db, hippoRoot, tenantId), backup: null };
  const backup = backupStore(db, hippoRoot, 'before-repair');
  const { result, rewrite, purge } = inTransaction(db, false, () => {
    const copies: string[] = [];
    for (const row of strayImports(db, hippoRoot, tenantId)) {
      const tag = toolTag(row.source);
      if (tag !== null && setAsideRow(db, tag, row, 'project-repair').kind === 'dormant') copies.push(row.id);
    }
    const folds = isGlobalStoreRoot(hippoRoot) ? planFolds(db, tenantId) : [];
    const folded = folds.map((f) => foldInTx(db, tenantId, f.from, f.into));
    const plan = planUserGlobalRepair(db, tenantId, []);
    const stamp = db.prepare(`UPDATE memories SET origin_project = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`);
    for (const { id, origin } of plan.toProject) stamp.run(origin, tenantId, id);
    const aside = new Set(plan.setAside);
    const now = new Date();
    for (const row of selectAllEntries(db, tenantId).filter((e) => aside.has(e.id))) {
      insertDormantRow(db, { entry: row, strength: calculateStrength(row, now), reason: 'project-repair', dormantAt: now.toISOString() });
      deleteEntryRowInTx(db, row, ACTOR);
    }
    appendAuditEvent(db, { tenantId, actor: ACTOR, op: 'project_repair', metadata: { backup, copies, folds, folded, ...plan } });
    return {
      result: { copies, folds, ...plan, backup },
      rewrite: [...plan.toProject.map((r) => r.id), ...folded.flatMap((f) => f.restamped)],
      purge: [...copies, ...plan.setAside, ...folded.flatMap((f) => f.setAside)],
    };
  });
  refreshMirrors(db, hippoRoot, tenantId, rewrite, purge);
  return result;
}

/** After commit, as the agent memory sync does: a stale mirror would bring the old tag back on the next rebuild. */
function refreshMirrors(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, rewrite: readonly string[], purge: readonly string[]): void {
  const ids = new Set(rewrite);
  for (const entry of selectAllEntries(db, tenantId)) if (ids.has(entry.id)) writeEntryMirrors(hippoRoot, entry);
  for (const id of purge) removeEntryMirrors(hippoRoot, id);
}
