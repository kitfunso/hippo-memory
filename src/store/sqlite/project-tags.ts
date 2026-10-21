// hippo.db's ProjectTags group: the reads `hippo projects` plans from, and the merge and repair, each one transaction
// backed up first.
import { getMeta, setMeta, withTrialScope, withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { withBackup } from '../../db/backup.js';
import { calculateStrength, type MemoryEntry } from '../../base/memory/memory.js';
import { AGENT_MEMORY_SOURCE_PREFIX, isImport, noteKey, toolTag } from '../../base/memory/agent-memory-tools.js';
import { MAX_AUDIT_LIMIT } from '../../base/util/limits.js';
import { READ_PAGE_ROWS, rowsInPages } from '../../base/util/pages.js';
import { appendAuditEvents, queryAuditEvents } from './audit.js';
import {
  compactionOriginsWithCwd,
  compactionTranscripts,
  holdsOrigin,
  restampCompactionOrigin,
} from './compaction-rows.js';
import {
  dormantSnapshotsByIds,
  dormantSnapshotsFromOrigin,
  insertDormantRow,
  replaceDormantEntry,
} from './dormant-rows.js';
import {
  selectEntriesByIds,
  selectEntriesFromOrigin,
  selectLiveEntriesBySourcePrefix,
  selectOriginTallies,
} from './entry-reads.js';
import { deleteEntryRowInTx, restampOriginProject, stampOriginProjects, writeEntryMirrors } from './entry-writes.js';
import { removeEntryMirrors } from './mirrors.js';
import type { HandleOpener, StoreFiles, OnHandle } from './open.js';
import { setAsideRow } from './set-aside.js';
import { bound, boundWithFiles, type Bodies, type FileBodies } from './bound.js';
import type { Sync } from './served.js';
import type {
  AppliedMerge,
  AppliedRepair,
  FoldResult,
  MergeRequest,
  OriginRows,
  ProjectFold,
  ProjectTags,
  ProjectTagScope,
  RepairPlan,
  RowRead,
} from '../port/project-tags.js';
import type { EntryCursor } from '../port/types.js';

const TX_LABEL = 'merge_projects';
const AUTO_REPAIR_META_KEY = 'project_repair_auto';

/** A rewrite's answer plus the ids whose mirrors are rewritten, and those whose mirrors go, once it commits. */
interface TagRewrite<T> {
  readonly result: T;
  readonly rewrite: readonly string[];
  readonly purge: readonly string[];
}

/** One transaction, the store backed up first, with mirrors following the commit. */
function rewrite<T>(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  backupLabel: string,
  body: (backup: string) => TagRewrite<T>,
): T {
  const done = withBackup(db, files.hippoRoot, backupLabel, (backup) =>
    withWriteScope(db, TX_LABEL, () => body(backup)),
  );
  // After commit, as the agent memory sync does: a stale mirror would bring the old tag back on the next rebuild.
  for (const entry of selectEntriesByIds(db, done.rewrite, tenantId).values()) {
    writeEntryMirrors(files.hippoRoot, entry);
  }
  for (const id of done.purge) removeEntryMirrors(files.hippoRoot, id);
  return done.result;
}

function originRows(db: DatabaseSyncLike, tenantId: string, rows: OriginRows): Iterable<MemoryEntry> {
  return rowsInPages((after?: EntryCursor) =>
    selectEntriesFromOrigin(db, tenantId, rows, { limit: READ_PAGE_ROWS, after }),
  );
}

/** Re-tags `from`'s rows, snapshots and compactions to `into`, setting aside the imports `into` already holds. */
function fold(db: DatabaseSyncLike, files: StoreFiles, tenantId: string, { from, into }: ProjectFold): FoldResult {
  // The sync renames the rest to `into`'s prefix and keeps their ids; only a note `into` already holds would show
  // twice.
  const held = new Set<string>();
  for (const row of originRows(db, tenantId, { origin: into, live: true, sourcePrefix: AGENT_MEMORY_SOURCE_PREFIX })) {
    held.add(noteKey(row.source));
  }
  const setAside: string[] = [];
  const restamped: string[] = [];
  // A row set aside sits at or before the page cursor, so the write never moves a row the walk has yet to read.
  for (const row of originRows(db, tenantId, { origin: from })) {
    const tag = toolTag(row.source);
    const live = isImport(row.source) && !row.supersededBy && row.kind !== 'raw';
    const copy = live && tag !== null && held.has(noteKey(row.source));
    if (copy && setAsideRow(db, tag, { ...row, originProject: into }, 'project-merge', files).kind === 'dormant') {
      setAside.push(row.id);
    } else restamped.push(row.id);
  }
  restampOriginProject(db, tenantId, from, into);
  const gone = new Set(setAside);
  const dormantRestamped: string[] = [];
  for (const snap of dormantSnapshotsFromOrigin(db, tenantId, from)) {
    if (gone.has(snap.entry.id)) continue;
    replaceDormantEntry(db, tenantId, snap.entry.id, { ...snap.entry, originProject: into });
    dormantRestamped.push(snap.entry.id);
  }
  const compactions = restampCompactionOrigin(db, tenantId, from, into);
  return { setAside, restamped, dormantRestamped, compactions };
}

function merge(
  db: DatabaseSyncLike,
  files: StoreFiles,
  { tenantId, actor }: ProjectTagScope,
  { from, into, dryRun }: MergeRequest,
): AppliedMerge {
  const body = (backup: string | null): TagRewrite<AppliedMerge> => {
    const folded = fold(db, files, tenantId, { from, into });
    appendAuditEvents(db, [{ tenantId, actor, op: 'project_merge', metadata: { from, into, backup, ...folded } }]);
    return { result: { ...folded, backup }, rewrite: folded.restamped, purge: folded.setAside };
  };
  // A dry run rolls back, so it writes no backup and no mirror.
  if (dryRun) return withTrialScope(db, TX_LABEL, () => body(null)).result;
  return rewrite(db, files, tenantId, 'before-merge', body);
}

/** Sets aside each planned copy still live under the name the plan read it with. */
function setAsideCopies(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  copies: readonly RowRead[],
): string[] {
  const rows = selectEntriesByIds(
    db,
    copies.map((c) => c.id),
    tenantId,
  );
  const done: string[] = [];
  for (const { id, origin } of copies) {
    const row = rows.get(id);
    const tag = row ? toolTag(row.source) : null;
    if (!row || tag === null || row.supersededBy || (row.originProject ?? null) !== origin) continue;
    if (setAsideRow(db, tag, row, 'project-repair', files).kind === 'dormant') done.push(id);
  }
  return done;
}

/** The planned sleep merges still live and user-global; the plan chose each by its parents, so one re-tagged since
 * stays as it is. */
function userGlobalMerges(db: DatabaseSyncLike, tenantId: string, ids: readonly string[]): Map<string, MemoryEntry> {
  const rows = selectEntriesByIds(db, ids, tenantId);
  return new Map([...rows].filter(([, e]) => !e.supersededBy && e.originProject === ''));
}

/** A live row to dormant storage, restorable, as sleep's dormant move does. */
function retire(db: DatabaseSyncLike, files: StoreFiles, row: MemoryEntry, actor: string, now: Date): void {
  insertDormantRow(db, {
    entry: row,
    strength: calculateStrength(row, now, files),
    reason: 'project-repair',
    dormantAt: now.toISOString(),
  });
  deleteEntryRowInTx(db, row, actor);
}

function repair(db: DatabaseSyncLike, files: StoreFiles, scope: ProjectTagScope, plan: RepairPlan): AppliedRepair {
  const { tenantId, actor } = scope;
  return rewrite(db, files, tenantId, 'before-repair', (backup) => {
    const copies = setAsideCopies(db, files, tenantId, plan.copies);
    const { folds, untraced } = plan;
    const folded = folds.map((f) => fold(db, files, tenantId, f));
    const merges = userGlobalMerges(db, tenantId, [...plan.toProject.map((r) => r.id), ...plan.setAside]);
    const toProject = plan.toProject.filter((r) => merges.has(r.id));
    stampOriginProjects(db, tenantId, toProject);
    const retired = plan.setAside.flatMap((id) => merges.get(id) ?? []);
    const now = new Date();
    for (const row of retired) retire(db, files, row, actor, now);
    const setAside = retired.map((row) => row.id);
    const metadata = { backup, copies, folds, folded, toProject, setAside, untraced };
    appendAuditEvents(db, [{ tenantId, actor, op: 'project_repair', metadata }]);
    return {
      result: { copies, toProject, setAside, backup },
      rewrite: [...toProject.map((r) => r.id), ...folded.flatMap((f) => f.restamped)],
      purge: [...copies, ...setAside, ...folded.flatMap((f) => f.setAside)],
    };
  });
}

type Reads = Omit<ProjectTags, 'merge' | 'repair' | 'markRepairedOnce'>;

const readsBodies: Bodies<Reads> = {
  originTallies: selectOriginTallies,
  entriesFromOrigin: selectEntriesFromOrigin,
  liveEntriesBySourcePrefix: selectLiveEntriesBySourcePrefix,
  entriesByIds: (db, tenantId, ids) => selectEntriesByIds(db, ids, tenantId),
  dormantFromOrigin: dormantSnapshotsFromOrigin,
  dormantByIds: dormantSnapshotsByIds,
  auditEvents: (db, tenantId, op) => queryAuditEvents(db, { tenantId, op, limit: MAX_AUDIT_LIMIT }),
  compactionTranscripts,
  compactionOriginsWithCwd,
  holdsOrigin: (db, tenantId, table, name) => holdsOrigin(db, table, tenantId, name),
  repairedOnce: (db) => getMeta(db, AUTO_REPAIR_META_KEY) === '1',
};

const writesBodies: FileBodies<Pick<ProjectTags, 'merge' | 'repair'>> = { merge: merge, repair: repair };

const markBodies: Bodies<Pick<ProjectTags, 'markRepairedOnce'>> = {
  markRepairedOnce: (db) => setMeta(db, AUTO_REPAIR_META_KEY, '1'),
};

/** `readOpener` opens the reads' handles: hippo.db's own open, which migrates an older schema first, unless a check
 * that must leave the store as it found it names a read-only one. */
export function sqliteProjectTags(on: OnHandle, readOpener?: HandleOpener): Sync<ProjectTags> {
  return {
    ...bound(on, readsBodies, readOpener),
    ...boundWithFiles(on, writesBodies),
    ...bound(on, markBodies),
  };
}
