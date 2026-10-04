// `hippo projects`: list the project names a store holds, fold one into another, and re-tag sleep's old user-global merges.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setAsideRow } from './agent-memories/apply.js';
import { AGENT_MEMORY_SOURCE_PREFIX, AGENT_MEMORY_TOOLS } from './agent-memories/tools.js';
import { appendAuditEvent } from './audit.js';
import type { DatabaseSyncLike } from './db.js';
import { insertDormantRow, listDormantSnapshots, replaceDormantEntry } from './dormant.js';
import { calculateStrength, type MemoryEntry } from './memory.js';
import { removeEntryMirrors } from './store/mirrors.js';
import { deleteEntryRowInTx, writeEntryMirrors } from './store/entry-writes.js';
import { selectAllEntries } from './store/entry-reads.js';

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

export interface RepairResult {
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
    if (isImport(e)) holders.set(e.content, (holders.get(e.content) ?? new Set<string | null>()).add(origin));
  }
  return [...byOrigin].map(([origin, rows]) => {
    const imports = rows.filter(isImport);
    return {
      origin,
      live: rows.length,
      imported: imports.length,
      newest: rows.reduce((max, e) => (e.created > max ? e.created : max), ''),
      copiesElsewhere: imports.filter((e) => (holders.get(e.content)?.size ?? 0) > 1).length,
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
    appendAuditEvent(db, {
      tenantId, actor: ACTOR, op: 'project_merge',
      metadata: { from, into, backup, setAside, restamped, dormantRestamped, compactions },
    });
    return { from, into, setAside, restamped, dormantRestamped, compactions, backup };
  });
  if (!dryRun) refreshMirrors(db, hippoRoot, tenantId, result.restamped, result.setAside);
  return result;
}

/** Reads only, so doctor can call it on a read-only handle: what the repair would do to each user-global merged row. */
export function planUserGlobalRepair(db: DatabaseSyncLike, tenantId: string): Omit<RepairResult, 'backup'> {
  const all = selectAllEntries(db, tenantId);
  const origins = new Map<string, string | null>(listDormantSnapshots(db, tenantId).map((s) => [s.entry.id, s.entry.origin_project ?? null]));
  for (const e of all) origins.set(e.id, e.origin_project ?? null);
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

/** Re-tags sleep's merged rows saved as user-global before the fix, by the projects of their parents. */
export function repairUserGlobalMerges(
  db: DatabaseSyncLike, hippoRoot: string, opts: { tenantId: string; dryRun: boolean },
): RepairResult {
  const { tenantId, dryRun } = opts;
  if (dryRun) return { ...planUserGlobalRepair(db, tenantId), backup: null };
  const backup = backupStore(db, hippoRoot, 'before-repair');
  const result = inTransaction(db, false, () => {
    const plan = planUserGlobalRepair(db, tenantId);
    const stamp = db.prepare(`UPDATE memories SET origin_project = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`);
    for (const { id, origin } of plan.toProject) stamp.run(origin, tenantId, id);
    const aside = new Set(plan.setAside);
    const now = new Date();
    for (const row of selectAllEntries(db, tenantId).filter((e) => aside.has(e.id))) {
      insertDormantRow(db, { entry: row, strength: calculateStrength(row, now), reason: 'project-repair', dormantAt: now.toISOString() });
      deleteEntryRowInTx(db, row, ACTOR);
    }
    appendAuditEvent(db, { tenantId, actor: ACTOR, op: 'project_repair', metadata: { backup, ...plan } });
    return { ...plan, backup };
  });
  refreshMirrors(db, hippoRoot, tenantId, result.toProject.map((r) => r.id), result.setAside);
  return result;
}

/** After commit, as the agent memory sync does: a stale mirror would bring the old tag back on the next rebuild. */
function refreshMirrors(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, rewrite: readonly string[], purge: readonly string[]): void {
  const ids = new Set(rewrite);
  for (const entry of selectAllEntries(db, tenantId)) if (ids.has(entry.id)) writeEntryMirrors(hippoRoot, entry);
  for (const id of purge) removeEntryMirrors(hippoRoot, id);
}
