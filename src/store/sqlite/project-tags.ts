// hippo.db's ProjectTags group: the rows `hippo projects` and sleep's tag repair read and write on one handle, so the
// merge and repair rules in src/sharing/project-merge.ts decide without holding it.
import { getMeta, setMeta, withTrialScope, withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { withBackup } from '../../db/backup.js';
import { calculateStrength, type LossAversion } from '../../core/memory.js';
import { MAX_AUDIT_LIMIT } from '../../util/limits.js';
import { READ_PAGE_ROWS, rowsInPages } from '../../util/pages.js';
import { appendAuditEvent, queryAuditEvents } from './audit.js';
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
  selectEntriesFromOriginAt,
  selectLiveEntriesBySourcePrefix,
  selectOriginTalliesAt,
} from './entry-reads.js';
import {
  deleteEntryRowInTx,
  restampOriginProjectAt,
  stampOriginProjectsAt,
  writeEntryMirrors,
} from './entry-writes.js';
import { removeEntryMirrors } from './mirrors.js';
import type { StoreFiles, OnHandle } from './open.js';
import { setAsideRow } from './set-aside.js';
import type {
  ProjectTagReads,
  ProjectTagScope,
  ProjectTagStore,
  ProjectTagWrites,
  TagRewrite,
  ProjectTags,
} from '../port/project-tags.js';
import type { EntryCursor } from '../port/consolidation.js';

const TX_LABEL = 'merge_projects';
const AUTO_REPAIR_META_KEY = 'project_repair_auto';

/** Reads on a handle the caller opened and closes, for doctor's read-only check and the note sync. */
export function projectTagReads(db: DatabaseSyncLike, tenantId: string): ProjectTagReads {
  return {
    originTallies: (sourcePrefix) => selectOriginTalliesAt(db, tenantId, sourcePrefix),
    entriesFromOrigin: (rows) =>
      rowsInPages((after?: EntryCursor) =>
        selectEntriesFromOriginAt(db, tenantId, rows, { limit: READ_PAGE_ROWS, after }),
      ),
    liveEntriesBySourcePrefix: (prefix) =>
      rowsInPages((after?: EntryCursor) =>
        selectLiveEntriesBySourcePrefix(db, tenantId, prefix, { limit: READ_PAGE_ROWS, after }),
      ),
    entriesByIds: (ids) => selectEntriesByIds(db, ids, tenantId),
    dormantFromOrigin: (origin) => dormantSnapshotsFromOrigin(db, tenantId, origin),
    dormantByIds: (ids) => dormantSnapshotsByIds(db, tenantId, ids),
    auditEvents: (op) => queryAuditEvents(db, { tenantId, op, limit: MAX_AUDIT_LIMIT }),
    compactionTranscripts: () => compactionTranscripts(db, tenantId),
    compactionOriginsWithCwd: () => compactionOriginsWithCwd(db, tenantId),
    holdsOrigin: (table, name) => holdsOrigin(db, table, tenantId, name),
  };
}

function projectTagWrites(
  db: DatabaseSyncLike,
  { tenantId, actor }: ProjectTagScope,
  rules: LossAversion,
): ProjectTagWrites {
  return {
    ...projectTagReads(db, tenantId),
    setAside: (tag, row, why) => setAsideRow(db, tag, row, why, rules),
    restampOrigin: (from, into) => restampOriginProjectAt(db, tenantId, from, into),
    restampCompactions: (from, into) => restampCompactionOrigin(db, tenantId, from, into),
    replaceDormant: (id, entry) => replaceDormantEntry(db, tenantId, id, entry),
    stampOrigins: (rows) => stampOriginProjectsAt(db, tenantId, rows),
    retire: (row, reason, now) => {
      insertDormantRow(db, {
        entry: row,
        strength: calculateStrength(row, now, rules),
        reason,
        dormantAt: now.toISOString(),
      });
      deleteEntryRowInTx(db, row, actor);
    },
    audit: (op, metadata) => appendAuditEvent(db, { tenantId, actor, op, metadata }),
  };
}

function rewriteOn<T>(
  db: DatabaseSyncLike,
  files: StoreFiles,
  scope: ProjectTagScope,
  opts: { readonly dryRun: boolean; readonly backupLabel: string },
  body: (tx: ProjectTagWrites, backup: string | null) => TagRewrite<T>,
): T {
  const tx = projectTagWrites(db, scope, files);
  if (opts.dryRun) return withTrialScope(db, TX_LABEL, () => body(tx, null)).result;
  const done = withBackup(db, files.hippoRoot, opts.backupLabel, (backup) =>
    withWriteScope(db, TX_LABEL, () => body(tx, backup)),
  );
  // After commit, as the agent memory sync does: a stale mirror would bring the old tag back on the next rebuild.
  for (const entry of selectEntriesByIds(db, done.rewrite, scope.tenantId).values()) {
    writeEntryMirrors(files.hippoRoot, entry);
  }
  for (const id of done.purge) removeEntryMirrors(files.hippoRoot, id);
  return done.result;
}

/** The tag store on a handle the caller opened and closes, with the folder its rewrites back up and re-mirror. */
function projectTagStoreOn(db: DatabaseSyncLike, files: StoreFiles, scope: ProjectTagScope): ProjectTagStore {
  return {
    ...projectTagReads(db, scope.tenantId),
    hippoRoot: files.hippoRoot,
    rewrite: (opts, body) => rewriteOn(db, files, scope, opts, body),
    repairedOnce: () => getMeta(db, AUTO_REPAIR_META_KEY) === '1',
    markRepairedOnce: () => setMeta(db, AUTO_REPAIR_META_KEY, '1'),
  };
}

export function sqliteProjectTags(on: OnHandle): ProjectTags {
  return {
    on: (scope, fn) => on((db, files) => fn(projectTagStoreOn(db, files, scope))),
  };
}
