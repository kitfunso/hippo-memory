// hippo.db's ProjectTags group: the reads `hippo projects` plans from, and the merge and repair,
// each one transaction backed up first.
import {
  getMeta,
  setMeta,
  withTrialScope,
  withWriteScope,
  type DatabaseSyncLike,
} from '../../../db/index.js';
import { withBackup } from '../../../db/backup.js';
import { calculateStrength } from '../../../base/memory/strength.js';
import type { MemoryEntry } from '../../../base/memory/entry.js';
import {
  AGENT_MEMORY_SOURCE_PREFIX,
  isImport,
  noteKey,
  toolTag,
} from '../../../base/memory/agent-memory-tools.js';
import { READ_PAGE_ROWS, rowsInPages } from '../../../base/util/pages.js';
import { appendAuditEvents } from '../audit/audit.js';
import { compactionOrigins, restampCompactionOrigin } from '../capture/compaction-rows.js';
import {
  dormantSnapshotsWhere,
  insertDormantRow,
  replaceDormantEntry,
} from '../dormant/dormant-rows.js';
import { readEntriesByIds, countByOrigin } from '../entries/entry-reads.js';
import { writeEntryMirrors } from '../entries/entry-writes.js';
import {
  deleteEntryRowInTx,
  restampOriginProject,
  stampOriginProjects,
} from '../entries/entry-row.js';
import { removeEntryMirrors } from '../folder-files/mirrors.js';
import type { Handles, HandleOpener, StoreFiles } from '../runtime/open.js';
import { setAsideRow } from '../entries/set-aside.js';
import { bound, type Bodies } from '../runtime/bound.js';
import type {
  AppliedMerge,
  AppliedRepair,
  FoldResult,
  MergeRequest,
  ProjectFold,
  ProjectTags,
  ProjectTagScope,
  RepairPlan,
  RowRead,
} from '../../../base/records/project-tags.js';
import type { EntryFilter } from '../../../base/records/reports.js';
import type { EntryCursor } from '../../../base/ports/store/types.js';
import { listEntriesWhere } from '../entries/entry-filter.js';
import { META_KEY } from '../../../db/meta.js';

const TX_LABEL = 'merge_projects';

/** A rewrite's answer plus the ids whose mirrors are rewritten, and those whose mirrors go, once
 * it commits. */
interface TagRewrite<T> {
  readonly result: T;
  readonly rewrite: readonly string[];
  readonly purge: readonly string[];
}

interface RewriteStep<T> {
  readonly tenantId: string;
  readonly backupLabel: string;
  readonly body: (backup: string) => TagRewrite<T>;
}

/** One transaction, the store backed up first, with mirrors following the commit. */
function rewrite<T>(
  db: DatabaseSyncLike,
  files: StoreFiles,
  { tenantId, backupLabel, body }: RewriteStep<T>,
): T {
  const done = withBackup(db, files.hippoRoot, backupLabel, (backup) =>
    withWriteScope(db, TX_LABEL, () => body(backup)),
  );
  // After commit, as the agent memory sync does: a stale mirror would bring the old tag back on the
  // next rebuild.
  for (const entry of readEntriesByIds(db, done.rewrite, tenantId).values()) {
    writeEntryMirrors(files.hippoRoot, entry);
  }
  for (const id of done.purge) removeEntryMirrors(files.hippoRoot, id);
  return done.result;
}

function rowsWhere(db: DatabaseSyncLike, filter: EntryFilter): Iterable<MemoryEntry> {
  return rowsInPages((after?: EntryCursor) =>
    listEntriesWhere(db, filter, { limit: READ_PAGE_ROWS, after }),
  );
}

/** The keys of the live imports `into` already holds. */
function heldNotes(db: DatabaseSyncLike, tenantId: string, into: string): Set<string> {
  const held = new Set<string>();
  const imports = {
    tenantId,
    origins: [into],
    live: true,
    sourcePrefix: AGENT_MEMORY_SOURCE_PREFIX,
  } as const;
  for (const row of rowsWhere(db, imports)) {
    held.add(noteKey(row.source));
  }
  return held;
}

/** Re-tags `from`'s rows, snapshots and compactions to `into`, setting aside the imports `into`
 * already holds. */
function fold(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  { from, into }: ProjectFold,
): FoldResult {
  // The sync renames the rest to `into`'s prefix and keeps their ids; only a note `into` already
  // holds would show twice.
  const held = heldNotes(db, tenantId, into);
  const setAside: string[] = [];
  const restamped: string[] = [];
  // A row set aside sits at or before the page cursor, so the write never moves a row the walk has
  // yet to read.
  for (const row of rowsWhere(db, { tenantId, origins: [from] })) {
    const tag = toolTag(row.source);
    const live = isImport(row.source) && !row.supersededBy && row.kind !== 'raw';
    const copy = live && tag !== null && held.has(noteKey(row.source));
    if (
      copy &&
      setAsideRow(db, {
        tag,
        row: { ...row, originProject: into },
        why: 'project-merge',
        rules: files,
      }).kind === 'dormant'
    ) {
      setAside.push(row.id);
    } else restamped.push(row.id);
  }
  restampOriginProject(db, { tenantId, from, into });
  const gone = new Set(setAside);
  const dormantRestamped: string[] = [];
  for (const snap of dormantSnapshotsWhere(db, { tenantId, origins: [from] })) {
    if (gone.has(snap.entry.id)) continue;
    replaceDormantEntry(db, tenantId, snap.entry.id, { ...snap.entry, originProject: into });
    dormantRestamped.push(snap.entry.id);
  }
  const compactions = restampCompactionOrigin(db, { tenantId, from, into });
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
    appendAuditEvents(db, [
      { tenantId, actor, op: 'project_merge', metadata: { from, into, backup, ...folded } },
    ]);
    return { result: { ...folded, backup }, rewrite: folded.restamped, purge: folded.setAside };
  };
  // A dry run rolls back, so it writes no backup and no mirror.
  if (dryRun) return withTrialScope(db, TX_LABEL, () => body(null)).result;
  return rewrite(db, files, { tenantId, backupLabel: 'before-merge', body });
}

/** Sets aside each planned copy still live under the name the plan read it with. */
function setAsideCopies(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  copies: readonly RowRead[],
): string[] {
  const rows = readEntriesByIds(
    db,
    copies.map((c) => c.id),
    tenantId,
  );
  const done: string[] = [];
  for (const { id, origin } of copies) {
    const row = rows.get(id);
    const tag = row ? toolTag(row.source) : null;
    if (!row || tag === null || row.supersededBy || (row.originProject ?? null) !== origin) {
      continue;
    }
    if (setAsideRow(db, { tag, row, why: 'project-repair', rules: files }).kind === 'dormant') {
      done.push(id);
    }
  }
  return done;
}

/** The planned sleep merges still live and user-global; the plan chose each by its parents, so
 * one re-tagged since stays as it is. */
function userGlobalMerges(
  db: DatabaseSyncLike,
  tenantId: string,
  ids: readonly string[],
): Map<string, MemoryEntry> {
  const rows = readEntriesByIds(db, ids, tenantId);
  return new Map([...rows].filter(([, e]) => !e.supersededBy && e.originProject === ''));
}

interface RetireOptions {
  readonly files: StoreFiles;
  readonly row: MemoryEntry;
  readonly actor: string;
  readonly now: Date;
}

/** A live row to dormant storage, restorable, as sleep's dormant move does. */
function retire(db: DatabaseSyncLike, { files, row, actor, now }: RetireOptions): void {
  insertDormantRow(db, {
    entry: row,
    strength: calculateStrength(row, now, files.strength),
    reason: 'project-repair',
    dormantAt: now.toISOString(),
  });
  deleteEntryRowInTx(db, row, actor);
}

function repair(
  db: DatabaseSyncLike,
  files: StoreFiles,
  scope: ProjectTagScope,
  plan: RepairPlan,
): AppliedRepair {
  const { tenantId, actor } = scope;
  const body = (backup: string): TagRewrite<AppliedRepair> => {
    const copies = setAsideCopies(db, files, tenantId, plan.copies);
    const { folds, untraced } = plan;
    const folded = folds.map((f) => fold(db, files, tenantId, f));
    const merges = userGlobalMerges(db, tenantId, [
      ...plan.toProject.map((r) => r.id),
      ...plan.setAside,
    ]);
    const toProject = plan.toProject.filter((r) => merges.has(r.id));
    stampOriginProjects(db, tenantId, toProject);
    const retired = plan.setAside.flatMap((id) => merges.get(id) ?? []);
    const now = files.clock();
    for (const row of retired) retire(db, { files, row, actor, now });
    const setAside = retired.map((row) => row.id);
    const metadata = { backup, copies, folds, folded, toProject, setAside, untraced };
    appendAuditEvents(db, [{ tenantId, actor, op: 'project_repair', metadata }]);
    return {
      result: { copies, toProject, setAside, backup },
      rewrite: [...toProject.map((r) => r.id), ...folded.flatMap((f) => f.restamped)],
      purge: [...copies, ...setAside, ...folded.flatMap((f) => f.setAside)],
    };
  };
  return rewrite(db, files, { tenantId, backupLabel: 'before-repair', body });
}

type Reads = Omit<ProjectTags, 'merge' | 'repair' | 'markRepairedOnce'>;

const readsBodies: Bodies<Reads> = {
  originTallies: countByOrigin,
  dormantWhere: dormantSnapshotsWhere,
  compactionOrigins,
  repairedOnce: (db) => getMeta(db, META_KEY.projectRepairAuto) === '1',
};

function writesBodies(files: StoreFiles): Bodies<Pick<ProjectTags, 'merge' | 'repair'>> {
  return {
    merge: (db, ...args) => merge(db, files, ...args),
    repair: (db, ...args) => repair(db, files, ...args),
  };
}

const markBodies: Bodies<Pick<ProjectTags, 'markRepairedOnce'>> = {
  markRepairedOnce: (db) => setMeta(db, META_KEY.projectRepairAuto, '1'),
};

/** `readOpener` opens the reads' handles: hippo.db's own open, which migrates an older schema
 * first, unless a check that must leave the store as it found it names a read-only one. */
export function sqliteProjectTags({ on, files }: Handles, readOpener?: HandleOpener): ProjectTags {
  return {
    ...bound(on, readsBodies, readOpener),
    ...bound(on, writesBodies(files)),
    ...bound(on, markBodies),
  };
}
