// The entry write path every writer shares, and the retrieval strengthen. A name ending InTx writes
// inside the caller's transaction; one ending InOwnTx opens a write scope of its own on its handle.
import { type MemoryEntry, markRetrieved } from '../../../base/memory/entry.js';
import {
  closeHippoDb,
  type DatabaseSyncLike,
  type DbGrant,
  withWriteScope,
} from '../../../db/index.js';
import { rethrowIfStoreBlocked } from '../../../base/util/store-blocked.js';
import { RejectedValueError, CrossTenantIdError } from '../../../base/errors/api-errors.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import { errorMessage, log, errorFields } from '../../../base/util/log.js';
import { auditRejectionRefusal, audit } from '../audit/audit-event.js';
import { appendAuditEvents } from '../audit/audit.js';
import { readEntriesByIds } from './entry-reads.js';
import { stampOriginProject, upsertEntryRow } from './entry-row.js';
import { mirrorBestEffort, writeMarkdownMirror } from '../folder-files/mirrors.js';
import type { StoreFiles, StoreModel } from '../runtime/open.js';
import { bindHandleClock } from '../runtime/handle-clock.js';
import { CLI_ACTOR } from '../../../base/records/audit-ops.js';
import type { StrengthenOptions } from '../../../base/ports/store/recall-writes.js';
import { cachedStatement } from '../../../db/statement-cache.js';

export interface WriteEntryOptions {
  actor?: string;
  /** Runs after the row commits and before the mirrors, on an idle connection; keep it
   * best-effort. */
  afterCommit?: () => void;
}

/** Store-side only, never exported from a package entry: `afterWrite` hands the write's own db
 * handle to the hook. */
interface WriteEntryInternalOptions extends WriteEntryOptions {
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
  writeEntryInOwnTx(db, files, entry, { actor: opts.actor, afterWrite });
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
  auditingRefusal(db, CLI_ACTOR, () =>
    withWriteScope(db, 'write_entries_together', () => {
      for (const entry of stamped) writeEntryDbOnly(db, entry);
    }),
  );
  for (const entry of stamped) writeEntryMirrors(files.hippoRoot, entry);
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

/** One row in a write scope of its own on the caller's handle, so a loop of writes opens the store
 * once and each row commits alone; a store-side `opts.afterWrite` shares the INSERT's SAVEPOINT, so
 * its throw undoes the row. Mirrors follow the commit. */
export function writeEntryInOwnTx(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entry: MemoryEntry,
  opts?: WriteEntryInternalOptions,
): void {
  const stamped = stampOriginProject(files, entry);
  auditingRefusal(db, opts?.actor ?? CLI_ACTOR, () => writeEntryDbOnly(db, stamped, opts));
  opts?.afterCommit?.();
  writeEntryMirrors(files.hippoRoot, stamped);
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

/** A handle of its own on a store, as the global store's strengthen opens. */
interface OwnHandle {
  readonly hippoRoot: string;
  readonly grant: DbGrant;
}

/** The handle a strengthen runs on: the caller's inside its transaction, where a failure throws for
 * the caller to undo; the caller's in a write scope of its own, so a recall's last writes share it;
 * or one it opens and closes. */
export type StrengthenOn =
  | { readonly inTx: DatabaseSyncLike }
  | { readonly inOwnTx: DatabaseSyncLike }
  | OwnHandle;

/** Strengthens the live rows among `ids`: only their four retrieval columns change. Outside the
 * caller's transaction it is best effort, so a failure logs and never fails the read. Returns the
 * ids found. */
export function strengthenRetrieved(
  on: StrengthenOn,
  ids: readonly string[],
  opts: StrengthenOptions,
  rules: StoreModel,
): Set<string> {
  // No ids, or a run that ablates the recall boost: no handle opens and no scope starts.
  if (ids.length === 0 || opts.recallBoostAblated) return new Set();
  if ('inTx' in on) return strengthenRows(on.inTx, ids, opts, rules);
  const db = 'inOwnTx' in on ? on.inOwnTx : openToStrengthen(on, rules);
  if (db === undefined) return new Set();
  try {
    return withWriteScope(db, 'strengthen_retrieved', () => strengthenRows(db, ids, opts, rules));
  } catch (error) {
    warnStrengthenFailed(error);
    return new Set();
  } finally {
    if (!('inOwnTx' in on)) closeHippoDb(db);
  }
}

/** Undefined, with a warning, when the store cannot open; a blocked store still throws. */
function openToStrengthen(
  { hippoRoot, grant }: OwnHandle,
  rules: StoreModel,
): DatabaseSyncLike | undefined {
  try {
    return bindHandleClock(grant.open(hippoRoot), rules.clock);
  } catch (error) {
    rethrowIfStoreBlocked(error);
    warnStrengthenFailed(error);
    return undefined;
  }
}

function warnStrengthenFailed<E>(error: E): void {
  log.warn(`retrieval stats not saved (${errorMessage(error)})`, errorFields(error));
}

// One statement text for any number of rows. Numbers round-trip through JSON exactly from 1e-80 up;
// only the cached strength of a long-decayed wrong memory falls below, and that one may land a unit
// in the last place off.
const RETRIEVAL_UPDATE_SQL =
  `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS rc, ` +
  `json_extract(value, '$[2]') AS lr, json_extract(value, '$[3]') AS hl, json_extract(value, '$[4]') AS st ` +
  `FROM json_each(?)) UPDATE memories SET retrieval_count = v.rc, last_retrieved = v.lr, half_life_days = v.hl, ` +
  `strength = v.st FROM v WHERE memories.id = v.id`;

function strengthenRows(
  db: DatabaseSyncLike,
  ids: readonly string[],
  opts: StrengthenOptions,
  rules: StoreModel,
): Set<string> {
  const found = new Set<string>();
  const byId = readEntriesByIds(db, ids, opts.tenantId);
  const live = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
  const updated = markRetrieved(live, rules.clock(), rules.strength);
  if (updated.length === 0) return found;
  const rows = updated.map((e) => [
    e.id,
    e.retrievalCount,
    e.lastRetrieved,
    e.halfLifeDays,
    e.strength,
  ]);
  cachedStatement(db, RETRIEVAL_UPDATE_SQL).run(JSON.stringify(rows));
  for (const e of updated) found.add(e.id);
  return found;
}

/** The refusal row lands after `write` has rolled back, in a fresh implicit transaction the
 * aborted one cannot undo. */
export function auditingRefusal<T>(db: DatabaseSyncLike, actor: string, write: () => T): T {
  try {
    return write();
  } catch (err) {
    if (err instanceof RejectedValueError) auditRejectionRefusal(db, err, actor);
    throw err;
  }
}
