// The rows `hippo projects` and sleep's tag repair read and write, bound to one hippo.db handle and tenant,
// so the merge and repair rules in src/sharing/project-merge.ts decide without holding the handle.
import { getMeta, setMeta, withTrialScope, withWriteScope, type DatabaseSyncLike } from '../db/index.js';
import { withBackup } from '../db/backup.js';
import { calculateStrength, type MemoryEntry } from '../core/memory.js';
import { appendAuditEvent, queryAuditEvents, type AppendAuditOpts, type AuditEvent } from './audit.js';
import { compactionOriginsWithCwd, compactionTranscripts, holdsOrigin, restampCompactionOrigin } from './compactions.js';
import { insertDormantRow, listDormantSnapshots, replaceDormantEntry, type DormantReason, type DormantSnapshot } from './dormant.js';
import { selectAllEntries, selectEntriesByIds, selectLiveEntriesBySourcePrefix } from './entry-reads.js';
import { deleteEntryRowInTx, restampOriginProjectAt, stampOriginProjectsAt, writeEntryMirrors } from './entry-writes.js';
import { removeEntryMirrors } from './mirrors.js';
import { onHandle } from './open.js';
import { setAsideRow, type SetAsideResult, type SetAsideWhy } from './set-aside.js';

export type ProjectTagOp = 'project_merge' | 'project_repair';

export interface ProjectTagReads {
  entries(): MemoryEntry[];
  liveEntriesBySourcePrefix(prefix: string): MemoryEntry[];
  entriesByIds(ids: readonly string[]): Map<string, MemoryEntry>;
  dormant(): DormantSnapshot[];
  auditEvents(op: ProjectTagOp): AuditEvent[];
  compactionTranscripts(): Array<{ transcript: string; cwd: string | null }>;
  compactionOriginsWithCwd(): Array<{ origin: string; cwd: string }>;
  holdsOrigin(table: 'memories' | 'compactions', name: string): boolean;
}

export interface ProjectTagWrites extends ProjectTagReads {
  setAside(tag: string, row: MemoryEntry, why: SetAsideWhy): SetAsideResult;
  restampOrigin(from: string, into: string): void;
  restampCompactions(from: string, into: string): number;
  replaceDormant(id: string, entry: MemoryEntry): void;
  stampOrigins(rows: ReadonlyArray<{ readonly id: string; readonly origin: string }>): void;
  /** A live row to dormant storage, restorable, as sleep's dormant move does. */
  retire(row: MemoryEntry, reason: DormantReason, now: Date): void;
  audit(op: ProjectTagOp, metadata: AppendAuditOpts['metadata']): void;
}

/** A rewrite's answer plus the ids whose mirrors are rewritten, and those whose mirrors go, once it commits. */
export interface TagRewrite<T> {
  readonly result: T;
  readonly rewrite: readonly string[];
  readonly purge: readonly string[];
}

export interface ProjectTagStore extends ProjectTagReads {
  readonly hippoRoot: string;
  /** One transaction; a dry run rolls back with no backup, else the store is backed up first and mirrors follow the commit. */
  rewrite<T>(opts: { readonly dryRun: boolean; readonly backupLabel: string }, body: (tx: ProjectTagWrites, backup: string | null) => TagRewrite<T>): T;
  repairedOnce(): boolean;
  markRepairedOnce(): void;
}

export interface ProjectTagScope {
  readonly hippoRoot: string;
  readonly tenantId: string;
  /** Who the audit rows name. */
  readonly actor: string;
}

const AUDIT_READ_CAP = 10000;
const TX_LABEL = 'merge_projects';
const AUTO_REPAIR_META_KEY = 'project_repair_auto';

/** Reads on a handle the caller opened and closes, for doctor's read-only check and the note sync. */
export function projectTagReads(db: DatabaseSyncLike, tenantId: string): ProjectTagReads {
  return {
    entries: () => selectAllEntries(db, tenantId),
    liveEntriesBySourcePrefix: (prefix) => selectLiveEntriesBySourcePrefix(db, tenantId, prefix),
    entriesByIds: (ids) => selectEntriesByIds(db, ids, tenantId),
    dormant: () => listDormantSnapshots(db, tenantId),
    auditEvents: (op) => queryAuditEvents(db, { tenantId, op, limit: AUDIT_READ_CAP }),
    compactionTranscripts: () => compactionTranscripts(db, tenantId),
    compactionOriginsWithCwd: () => compactionOriginsWithCwd(db, tenantId),
    holdsOrigin: (table, name) => holdsOrigin(db, table, tenantId, name),
  };
}

function projectTagWrites(db: DatabaseSyncLike, { tenantId, actor }: ProjectTagScope): ProjectTagWrites {
  return {
    ...projectTagReads(db, tenantId),
    setAside: (tag, row, why) => setAsideRow(db, tag, row, why),
    restampOrigin: (from, into) => restampOriginProjectAt(db, tenantId, from, into),
    restampCompactions: (from, into) => restampCompactionOrigin(db, tenantId, from, into),
    replaceDormant: (id, entry) => replaceDormantEntry(db, tenantId, id, entry),
    stampOrigins: (rows) => stampOriginProjectsAt(db, tenantId, rows),
    retire: (row, reason, now) => {
      insertDormantRow(db, { entry: row, strength: calculateStrength(row, now), reason, dormantAt: now.toISOString() });
      deleteEntryRowInTx(db, row, actor);
    },
    audit: (op, metadata) => appendAuditEvent(db, { tenantId, actor, op, metadata }),
  };
}

function rewriteOn<T>(
  db: DatabaseSyncLike, scope: ProjectTagScope, opts: { readonly dryRun: boolean; readonly backupLabel: string },
  body: (tx: ProjectTagWrites, backup: string | null) => TagRewrite<T>,
): T {
  const tx = projectTagWrites(db, scope);
  if (opts.dryRun) return withTrialScope(db, TX_LABEL, () => body(tx, null)).result;
  const done = withBackup(db, scope.hippoRoot, opts.backupLabel, (backup) => withWriteScope(db, TX_LABEL, () => body(tx, backup)));
  // After commit, as the agent memory sync does: a stale mirror would bring the old tag back on the next rebuild.
  for (const entry of selectEntriesByIds(db, done.rewrite, scope.tenantId).values()) writeEntryMirrors(scope.hippoRoot, entry);
  for (const id of done.purge) removeEntryMirrors(scope.hippoRoot, id);
  return done.result;
}

/** Runs `fn` on hippo.db under `scope.hippoRoot`, opened for this call and closed after. */
export function onProjectTags<T>(scope: ProjectTagScope, fn: (store: ProjectTagStore) => T): T {
  return onHandle(scope.hippoRoot, (db) => fn({
    ...projectTagReads(db, scope.tenantId),
    hippoRoot: scope.hippoRoot,
    rewrite: (opts, body) => rewriteOn(db, scope, opts, body),
    repairedOnce: () => getMeta(db, AUTO_REPAIR_META_KEY) === '1',
    markRepairedOnce: () => setMeta(db, AUTO_REPAIR_META_KEY, '1'),
  }));
}
