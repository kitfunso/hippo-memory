// hippo.db's Rejections group: reject, unreject and list rejected values, each on one handle of its own.
// A file apart from rejection.ts: sqlite/open.ts imports that one, so an open there would be an import cycle.
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import type { MemoryEntry } from '../../core/memory.js';
import { heldTexts } from '../../util/same-text.js';
import { audit } from './audit-event.js';
import { deleteEntryCore } from './delete-and-batch.js';
import {
  deleteDormantRow,
  dormantSnapshotsByIds,
  dormantTextsByIds,
  dormantTextsPage,
  replaceDormantEntry,
} from './dormant-rows.js';
import { entryRejectRowAt, selectEntriesByIds, selectTenantTextsPage } from './entry-reads.js';
import { stampOriginProject } from './entry-row.js';
import { writeEntryDbOnly, writeEntryMirrors } from './entry-writes.js';
import { purgeMirrorBestEffort } from './mirrors.js';
import type { StoreFiles, OnHandle } from './open.js';
import { archiveRawMemory, markMirrorCleaned } from './raw-archive.js';
import { deleteRejectedValue, insertRejectedValue, listRejectedValues, checkRejectionGuard } from './rejection.js';
import { normalizeValueForRejection, rejectionDigest } from '../../core/rejection-digest.js';
import type { EntryCursor } from '../port/consolidation.js';
import type { AppliedRejection, HoldsValue, LiftedRejection, Rejection, Rejections } from '../port/rejections.js';
import { RejectedValueError } from '../../core/api-errors.js';
import { openStore } from './handles.js';
import type { Sync } from '../port.js';

/** Rows a rejection reads per page while it looks for the rows that hold its text. */
const HOLDER_PAGE_ROWS = 500;

/** What one rejection removed and wrote, gathered across the live and dormant passes. */
interface Removal {
  removedIds: string[];
  removedRawIds: string[];
  successors: MemoryEntry[];
  dormantSuccessorIds: string[];
}

/** The rows that hold the text, by table and by how they hold it. */
interface Holders {
  readonly live: { readonly whole: MemoryEntry[]; readonly merged: MemoryEntry[] };
  readonly dormant: { readonly whole: string[]; readonly merged: string[] };
}

/** How a row holds the rejected text: as its whole text, as one text of a sleep-merged row, or not at all. */
function holdOf(row: { content: string; source: string | null }, holdsValue: HoldsValue): 'whole' | 'merged' | null {
  if (holdsValue(row.content)) return 'whole';
  return heldTexts({ content: row.content, source: row.source ?? '' }).some(holdsValue) ? 'merged' : null;
}

/** The ids of the tenant's rows in reach that hold the text, live then dormant, read a page at a time with no lock
 * held: the rejected-value row is already committed, so no write can add a holder behind the walk. */
function findHolderIds(db: DatabaseSyncLike, rejection: Rejection, holdsValue: HoldsValue): string[] {
  const { tenantId } = rejection;
  const found: string[] = [];
  const keep = (row: { id: string; content: string; source: string | null; scope: string | null }): void => {
    if (rejection.inReach(row.scope) && holdOf(row, holdsValue) !== null) found.push(row.id);
  };
  let after: EntryCursor | null = null;
  do {
    const page = selectTenantTextsPage(db, tenantId, { limit: HOLDER_PAGE_ROWS, after: after ?? undefined });
    page.texts.forEach(keep);
    after = page.next;
  } while (after !== null);
  for (let afterId = ''; ;) {
    const page = dormantTextsPage(db, tenantId, { limit: HOLDER_PAGE_ROWS, afterId });
    page.forEach(keep);
    if (page.length < HOLDER_PAGE_ROWS) return found;
    afterId = page[page.length - 1].id;
  }
}

/** The found rows read again under the write lock, each still in reach and still holding the text; a row that sleep
 * moved between the walk and the lock is read from the table it now sits in. */
function heldUnderLock(db: DatabaseSyncLike, rejection: Rejection, holdsValue: HoldsValue, ids: string[]): Holders {
  const { tenantId, inReach } = rejection;
  const live = selectEntriesByIds(db, ids, tenantId);
  const dormant = dormantTextsByIds(
    db,
    tenantId,
    ids.filter((id) => !live.has(id)),
  );
  const liveHolding = (hold: 'whole' | 'merged'): MemoryEntry[] =>
    ids.flatMap((id) => {
      const row = live.get(id);
      return row && inReach(row.scope) && holdOf(row, holdsValue) === hold ? [row] : [];
    });
  const dormantHolding = (hold: 'whole' | 'merged'): string[] =>
    ids.filter((id) => {
      const row = dormant.get(id);
      return row !== undefined && inReach(row.scope) && holdOf(row, holdsValue) === hold;
    });
  return {
    live: { whole: liveHolding('whole'), merged: liveHolding('merged') },
    dormant: { whole: dormantHolding('whole'), merged: dormantHolding('merged') },
  };
}

function removeLiveRows(
  db: DatabaseSyncLike,
  hippoRoot: string,
  rejection: Rejection,
  holdsValue: HoldsValue,
  { live }: Holders,
  removal: Removal,
): void {
  const { tenantId, actor, reason } = rejection;
  const { removedIds, removedRawIds, successors } = removal;
  for (const row of live.whole) {
    if (row.kind === 'raw') {
      // A raw row is append-only: archiving is its one removal path, and its savepoint nests in this write scope.
      archiveRawMemory(db, row.id, { reason, who: actor });
      removedRawIds.push(row.id);
    } else {
      // The one reject_value row is the trail for these removals, so no forget row each.
      deleteEntryCore(db, row.id, tenantId, { actor, suppressForgetAudit: true });
    }
    removedIds.push(row.id);
  }
  for (const row of live.merged) {
    const successor = rejection.successorOf(row, holdsValue, new Set(removedIds));
    deleteEntryCore(db, row.id, tenantId, { actor, suppressForgetAudit: true });
    removedIds.push(row.id);
    if (!successor) continue;
    const kept = stampOriginProject(hippoRoot, successor);
    writeEntryDbOnly(db, kept, { actor });
    successors.push(kept);
  }
}

// Dormant copies go in the same write scope, so `hippo dormant restore` cannot bring the text back. They have no mirror
// to purge.
function removeDormantCopies(
  db: DatabaseSyncLike,
  rejection: Rejection,
  holdsValue: HoldsValue,
  { dormant }: Holders,
  removal: Removal,
): void {
  const { tenantId } = rejection;
  const { removedIds, dormantSuccessorIds } = removal;
  for (const id of dormant.whole) {
    deleteDormantRow(db, tenantId, id);
    removedIds.push(id);
  }
  const snapshots = dormantSnapshotsByIds(db, tenantId, dormant.merged);
  for (const id of dormant.merged) {
    const entry = snapshots.get(id)?.entry;
    const successor = entry && rejection.successorOf(entry, holdsValue, new Set(removedIds));
    if (successor === undefined) continue;
    removedIds.push(id);
    if (!successor) {
      deleteDormantRow(db, tenantId, id);
      continue;
    }
    replaceDormantEntry(db, tenantId, id, successor);
    dormantSuccessorIds.push(successor.id);
  }
}

// After the commit, on the same handle: a purged raw mirror is stamped so the reaper skips it, and one that stays is
// logged.
function purgeRemovedMirrors(db: DatabaseSyncLike, hippoRoot: string, removal: Removal): void {
  for (const id of removal.removedIds) {
    const isRaw = removal.removedRawIds.includes(id);
    const mirrorOk = purgeMirrorBestEffort(hippoRoot, id, isRaw, 'hippo reject');
    if (mirrorOk && isRaw) markMirrorCleaned(db, id, new Date().toISOString());
  }
  for (const successor of removal.successors) writeEntryMirrors(hippoRoot, successor);
}

/** One short write scope: every found row that still holds the text goes, with one reject_value audit row. */
function removeHolders(
  db: DatabaseSyncLike,
  hippoRoot: string,
  rejection: Rejection,
  { digest, holdsValue }: { digest: string; holdsValue: HoldsValue },
  found: string[],
): Removal {
  const removal: Removal = { removedIds: [], removedRawIds: [], successors: [], dormantSuccessorIds: [] };
  withWriteScope(db, 'reject_value', () => {
    const holders = heldUnderLock(db, rejection, holdsValue, found);
    removeLiveRows(db, hippoRoot, rejection, holdsValue, holders, removal);
    removeDormantCopies(db, rejection, holdsValue, holders, removal);
    // Still inside the write scope: a failed audit row is reported and the removal commits without it.
    const { tenantId, actor, memoryId } = rejection;
    const { removedIds } = removal;
    audit(db, 'reject_value', {
      tenantId,
      actor,
      targetId: memoryId,
      metadata: { digest, removedIds, count: removedIds.length },
    });
  });
  return removal;
}

/** Commits the rejected-value row first, so every later write refuses the text; walks the tenant's rows a page at a
 * time with no lock held; then removes each holder in reach (live or dormant, whole or merged) in one short write
 * scope. A failure past the first commit leaves the text refused and its holders kept; rejecting again removes them. */
function applyRejectionAt(db: DatabaseSyncLike, files: StoreFiles, rejection: Rejection): AppliedRejection {
  const { hippoRoot } = files;
  const { tenantId, actor, reason, memoryId } = rejection;
  const content = rejection.textOf(memoryId === undefined ? undefined : entryRejectRowAt(db, memoryId));
  const digest = rejectionDigest(content);
  const rejectedAt = new Date().toISOString();
  withWriteScope(db, 'reject_value_row', () =>
    insertRejectedValue(db, {
      tenantId,
      digest,
      reason,
      rejectedBy: actor,
      rejectedAt,
      sourceMemoryId: memoryId ?? null,
      normalizedChars: normalizeValueForRejection(content).length,
    }),
  );
  // SHORTCUT: hashes every text of the tenant, a page at a time with no lock held; a digest column needs a schema
  // migration, held until approved.
  const holdsValue: HoldsValue = (text) => rejectionDigest(text) === digest;
  const found = findHolderIds(db, rejection, holdsValue);
  const removal = removeHolders(db, hippoRoot, rejection, { digest, holdsValue }, found);

  purgeRemovedMirrors(db, hippoRoot, removal);

  const { removedIds, removedRawIds, successors, dormantSuccessorIds } = removal;
  return {
    digest,
    content,
    removedIds,
    removedRawIds,
    successorIds: successors.map((s) => s.id),
    dormantSuccessorIds,
  };
}

/** Deletes the tenant's one rejected value whose digest starts with `digestPrefix` and writes its unreject_value audit
 * row. No match, or more than one, writes nothing. */
function liftRejectionAt(db: DatabaseSyncLike, tenantId: string, digestPrefix: string, actor: string): LiftedRejection {
  const matches = listRejectedValues(db, tenantId).filter((r) => r.digest.startsWith(digestPrefix));
  const target = matches[0];
  if (target === undefined) return { status: 'not_found' };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches };

  deleteRejectedValue(db, tenantId, target.digest);
  audit(db, 'unreject_value', {
    tenantId,
    actor,
    targetId: target.sourceMemoryId ?? undefined,
    metadata: { digest: target.digest, reason: target.reason },
  });
  return { status: 'ok', digest: target.digest, reason: target.reason };
}

export function sqliteRejections(on: OnHandle): Sync<Rejections> {
  return {
    apply: (rejection) => on((db, files) => applyRejectionAt(db, files, rejection), openStore),
    lift: (tenantId, digestPrefix, actor) => on((db) => liftRejectionAt(db, tenantId, digestPrefix, actor), openStore),
    list: (tenantId) => on((db) => listRejectedValues(db, tenantId), openStore),
    refusedAmong: (checks) =>
      on((db) =>
        checks.map(({ tenantId, entryId, content }) => {
          try {
            checkRejectionGuard(db, tenantId, entryId, content);
            return false;
          } catch (err) {
            if (err instanceof RejectedValueError) return true;
            throw err;
          }
        }),
      ),
  };
}
