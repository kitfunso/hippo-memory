// hippo.db's shared entry write path: the row, its audit row and its mirror, alone or in a batch.
import { type MemoryEntry } from '../../base/memory/entry.js';
import { type DatabaseSyncLike, withWriteScope } from '../../db/index.js';
import { RejectedValueError, CrossTenantIdError } from '../../base/errors/api-errors.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import { log, errorFields } from '../../base/util/log.js';
import { auditRejectionRefusal, audit } from './audit-event.js';
import { appendAuditEvents } from './audit.js';
import { readEntriesByIds } from './entry-reads.js';
import { stampOriginProject, upsertEntryRow } from './entry-row.js';
import { mirrorBestEffort, writeMarkdownMirror } from './mirrors.js';
import type { StoreFiles } from './open.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';

export interface WriteEntryOptions {
  actor?: string;
  /** Runs after the row commits and before the mirrors, on an idle connection; keep it
   * best-effort. */
  afterCommit?: () => void;
}

/** Store-side only, never exported from a package entry: `afterWrite` hands the write's own db
 * handle to the hook. */
export interface WriteEntryInternalOptions extends WriteEntryOptions {
  /** Runs in the same SAVEPOINT as the INSERT, so a throw rolls the row back. */
  afterWrite?: (db: DatabaseSyncLike, memoryId: string) => void;
}

/** Writes a promoted copy on the caller's open store; with `auditAs` the `promote` audit row
 * joins the INSERT's SAVEPOINT, so both or neither. */
export function writePromotedEntry(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entry: MemoryEntry,
  opts: {
    readonly actor?: string;
    readonly sourceId: string;
    readonly auditAs?: { tenantId: string; actor: string };
  },
): void {
  const { auditAs, sourceId } = opts;
  const afterWrite =
    auditAs &&
    ((own: DatabaseSyncLike, globalId: string) => {
      appendAuditEvents(own, [
        {
          tenantId: auditAs.tenantId,
          actor: auditAs.actor,
          op: 'promote',
          targetId: globalId,
          metadata: { sourceId },
        },
      ]);
    });
  writeEntryOn(db, files, entry, { actor: opts.actor, afterWrite });
}

/** writeEntry for each of `entries` in one transaction, so all land or none; each keeps its
 * audit row, and mirrors follow the commit. Returns how many were written; an empty list opens
 * no store. */
export function writeEntriesTogether(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entries: readonly MemoryEntry[],
): number {
  const stamped = entries.map((entry) => stampOriginProject(files, entry));
  try {
    withWriteScope(db, 'write_entries_together', () => {
      for (const entry of stamped) writeEntryDbOnly(db, entry);
    });
    for (const entry of stamped) writeEntryMirrors(files.hippoRoot, entry);
  } catch (error) {
    // The scope has unwound, so the refusal row outlives the rollback, as writeEntry's does.
    if (error instanceof RejectedValueError) auditRejectionRefusal(db, error, CLI_ACTOR);
    throw error;
  }
  return stamped.length;
}

/** Runs `fill` in one transaction; each `put` writes one entry and returns false when the store
 * rejects its value, leaving that row's refusal audit and the rest of the batch. Mirrors follow the
 * commit. Returns how many were written.
 */
export function writeEntriesSkippingRejected(
  db: DatabaseSyncLike,
  files: StoreFiles,
  fill: (put: (entry: MemoryEntry) => boolean) => void,
  actor = CLI_ACTOR,
): number {
  const written: MemoryEntry[] = [];
  withWriteScope(db, 'write_entries_skipping_rejected', () => {
    fill((entry) => {
      const stamped = stampOriginProject(files, entry);
      try {
        writeEntryDbOnly(db, stamped, { actor });
      } catch (error) {
        // Skipped like a tombstoned value, so one foreign id cannot abort a sync or share batch;
        // the audit ops are a published list, so the refusal is logged instead of audited.
        if (error instanceof CrossTenantIdError) {
          log.warn(`${error.message}; row skipped`, errorFields(error));
          return false;
        }
        if (!(error instanceof RejectedValueError)) throw error;
        auditRejectionRefusal(db, error, actor);
        return false;
      }
      written.push(stamped);
      return true;
    });
  });
  for (const entry of written) writeEntryMirrors(files.hippoRoot, entry);
  return written.length;
}

/** Adds `tag` to each of a tenant's rows that lacks it, in `ids` order, all in one transaction;
 * an id the tenant does not hold is skipped. */
export function addTagToEntries(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  ids: readonly string[],
  tag: string,
): void {
  const live = readEntriesByIds(db, ids, tenantId);
  const tagged = [...new Set(ids)].flatMap((id) => {
    const entry = live.get(id);
    return !entry || entry.tags.includes(tag) ? [] : [{ ...entry, tags: [...entry.tags, tag] }];
  });
  if (tagged.length > 0) writeEntriesTogether(db, files, tagged);
}

/** writeEntry on the caller's open store, so a loop of writes opens the store once; each row
 * still commits alone. `opts.afterWrite` shares the INSERT's SAVEPOINT. */
export function writeEntryOn(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entry: MemoryEntry,
  opts?: WriteEntryInternalOptions,
): void {
  try {
    const stamped = stampOriginProject(files, entry);
    writeEntryDbOnly(db, stamped, opts);
    opts?.afterCommit?.();
    writeEntryMirrors(files.hippoRoot, stamped);
  } catch (error) {
    // writeEntryDbOnly's write scope has already unwound here, so the refusal audit lands
    // post-rollback in a fresh implicit transaction; then rethrow so the caller sees it.
    if (error instanceof RejectedValueError) {
      auditRejectionRefusal(db, error, opts?.actor ?? CLI_ACTOR);
    }
    throw error;
  }
}

/** DB-only write path: upsert, afterWrite hook and audit row inside one withWriteScope; the
 * caller owns `db` and must call `writeEntryMirrors` after any outer tx commits, so a
 * rolled-back tx never leaves orphan markdown. The audit row commits atomically with the INSERT. */
export function writeEntryDbOnly(
  db: DatabaseSyncLike,
  entry: MemoryEntry,
  opts?: Pick<WriteEntryInternalOptions, 'actor' | 'afterWrite'>,
): void {
  // Inside a caller's transaction (e.g. supersede's BEGIN IMMEDIATE) the scope is a SAVEPOINT, so a
  // throw here rolls back only this write and leaves the outer open.
  withWriteScope(db, 'write_entry', () => {
    upsertEntryRow(db, entry);
    if (opts?.afterWrite) {
      opts.afterWrite(db, entry.id);
    }
    auditEntryWrite(db, entry, opts?.actor ?? CLI_ACTOR);
  });
}

/** What follows a row's upsert inside its write scope: the remember row, last of the write's
 * audit rows, then the summary parent's dirty mark. */
export function auditEntryWrite(db: DatabaseSyncLike, entry: MemoryEntry, actor: string): void {
  const tenantId = entry.tenantId;
  audit(db, 'remember', {
    targetId: entry.id,
    metadata: rememberAuditMetadata(entry),
    actor,
    tenantId,
  });
  // A child write marks its summary parent dirty for the sleep-cycle rebuild; most writes have no
  // parent, so the hot path pays one null check.
  if (entry.dagParentId) {
    markSummaryDirtyInTx(db, { summaryId: entry.dagParentId, tenantId: entry.tenantId, actor });
  }
}

/** What a row write's `remember` audit row records. */
export function rememberAuditMetadata(entry: MemoryEntry) {
  return { kind: entry.kind ?? 'distilled', scope: entry.scope ?? null };
}

/** Markdown mirror path, invoked AFTER commit (a rolled-back tx must leave no orphan markdown). */
export function writeEntryMirrors(hippoRoot: string, entry: MemoryEntry): void {
  mirrorBestEffort(`${entry.id}.md`, () => writeMarkdownMirror(hippoRoot, entry));
}
