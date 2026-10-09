// Reject, unreject and list rejected values, each on one handle of its own.
// A file apart from rejection.ts: store/open.ts imports that one, so an open there would be an import cycle.

import { closeHippoDb, openHippoDb, withWriteScope, type DatabaseSyncLike } from '../db.js';
import type { MemoryEntry } from '../memory.js';
import { heldTexts } from '../same-text.js';
import { audit } from './audit-event.js';
import { deleteEntryCore } from './delete-and-batch.js';
import { deleteDormantRow, listDormantSnapshots, purgeDormantByDigest, replaceDormantEntry } from './dormant.js';
import { entryRejectRowAt, selectAllEntries } from './entry-reads.js';
import { stampOriginProject } from './entry-row.js';
import { writeEntryDbOnly, writeEntryMirrors } from './entry-writes.js';
import { purgeMirrorBestEffort } from './mirrors.js';
import { openStore } from './open.js';
import { archiveRawMemory, markMirrorCleaned } from './raw-archive.js';
import {
  RejectedValueError,
  checkRejectionGuard,
  deleteRejectedValue,
  insertRejectedValue,
  listRejectedValues,
  normalizeValueForRejection,
  rejectionDigest,
  type RejectedValueRow,
} from './rejection.js';

type HoldsValue = (text: string) => boolean;

/** The text, tenant and scope of the memory a rejection names. */
export type RejectionSource = NonNullable<ReturnType<typeof entryRejectRowAt>>;

/** One rejection as the store applies it. The three functions are the caller's policy over plain rows; none is handed the handle. */
export interface Rejection {
  readonly tenantId: string;
  readonly actor: string;
  readonly reason: string;
  /** The memory whose row `textOf` is given; unset when the caller supplies the text itself. */
  readonly memoryId?: string;
  /** The text to reject. `source` is undefined when `memoryId` is unset or names no row; a throw refuses before any write. */
  readonly textOf: (source: RejectionSource | undefined) => string;
  /** False for a row this caller may not remove. */
  readonly inReach: (scope: string | null | undefined) => boolean;
  /** What replaces a merged row once the rejected text leaves it: undefined when it holds none, null when nothing else is left. */
  readonly successorOf: (row: MemoryEntry, holdsValue: HoldsValue, removedIds: ReadonlySet<string>) => MemoryEntry | null | undefined;
}

export interface AppliedRejection {
  digest: string;
  /** The rejected text: the stored row keeps only its digest, so no later read can return it. */
  content: string;
  /** Every row removed, live or dormant: each whose digest matched, duplicates included, and each sleep-merged row holding the text. */
  removedIds: string[];
  /** The removedIds of kind 'raw', archived instead of deleted. */
  removedRawIds: string[];
  /** The rows that carry a live merged row's other texts; dormantSuccessorIds is the same for a dormant one. */
  successorIds: string[];
  dormantSuccessorIds: string[];
}

/** What one rejection removed and wrote, gathered across the live and dormant passes. */
interface Removal {
  removedIds: string[];
  removedRawIds: string[];
  successors: MemoryEntry[];
  dormantSuccessorIds: string[];
}

function removeLiveRows(db: DatabaseSyncLike, hippoRoot: string, rejection: Rejection, holdsValue: HoldsValue, removal: Removal): void {
  const { tenantId, actor, reason } = rejection;
  const { removedIds, removedRawIds, successors } = removal;
  const merged: MemoryEntry[] = [];
  for (const row of selectAllEntries(db, tenantId)) {
    if (!rejection.inReach(row.scope)) continue;
    if (!holdsValue(row.content)) {
      if (heldTexts(row).some(holdsValue)) merged.push(row);
      continue;
    }
    if (row.kind === 'raw') {
      // A raw row is append-only: archiving is its one removal path, and its savepoint nests in this write scope.
      archiveRawMemory(db, row.id, { reason, who: actor });
      removedRawIds.push(row.id);
    } else {
      // The one reject_value row is the trail for these removals, so no forget row each.
      deleteEntryCore(db, row.id, { actor, suppressForgetAudit: true });
    }
    removedIds.push(row.id);
  }
  for (const row of merged) {
    const successor = rejection.successorOf(row, holdsValue, new Set(removedIds));
    deleteEntryCore(db, row.id, { actor, suppressForgetAudit: true });
    removedIds.push(row.id);
    if (!successor) continue;
    const kept = stampOriginProject(hippoRoot, successor);
    writeEntryDbOnly(db, kept, { actor });
    successors.push(kept);
  }
}

// Dormant copies go in the same write scope, so `hippo dormant restore` cannot bring the text back. They have no mirror to purge.
function removeDormantCopies(db: DatabaseSyncLike, rejection: Rejection, digest: string, holdsValue: HoldsValue, removal: Removal): void {
  const { tenantId } = rejection;
  const { removedIds, dormantSuccessorIds } = removal;
  removedIds.push(...purgeDormantByDigest(db, tenantId, digest, rejection.inReach));
  for (const dormant of listDormantSnapshots(db, tenantId)) {
    if (!rejection.inReach(dormant.entry.scope)) continue;
    const successor = rejection.successorOf(dormant.entry, holdsValue, new Set(removedIds));
    if (successor === undefined) continue;
    removedIds.push(dormant.entry.id);
    if (!successor) {
      deleteDormantRow(db, tenantId, dormant.entry.id);
      continue;
    }
    replaceDormantEntry(db, tenantId, dormant.entry.id, successor);
    dormantSuccessorIds.push(successor.id);
  }
}

// After the commit, on the same handle: a purged raw mirror is stamped so the reaper skips it, and one that stays is logged.
function purgeRemovedMirrors(db: DatabaseSyncLike, hippoRoot: string, removal: Removal): void {
  for (const id of removal.removedIds) {
    const isRaw = removal.removedRawIds.includes(id);
    const mirrorOk = purgeMirrorBestEffort(hippoRoot, id, isRaw, 'hippo reject');
    if (mirrorOk && isRaw) markMirrorCleaned(db, id, new Date().toISOString());
  }
  for (const successor of removal.successors) writeEntryMirrors(hippoRoot, successor);
}

/** Applies one rejection on one handle and in one write scope: the rejected-value row, the removal of every row in reach that holds the
 *  text (live or dormant, whole or inside a merged row) and one reject_value audit row. Markdown mirrors follow the commit. */
export function applyRejection(hippoRoot: string, rejection: Rejection): AppliedRejection {
  const { tenantId, actor, reason, memoryId } = rejection;
  const db = openStore(hippoRoot);
  try {
    const content = rejection.textOf(memoryId === undefined ? undefined : entryRejectRowAt(db, memoryId));
    const digest = rejectionDigest(content);
    const rejectedAt = new Date().toISOString();
    const removal: Removal = { removedIds: [], removedRawIds: [], successors: [], dormantSuccessorIds: [] };

    withWriteScope(db, 'reject_value', () => {
      insertRejectedValue(db, {
        tenantId,
        digest,
        reason,
        rejectedBy: actor,
        rejectedAt,
        sourceMemoryId: memoryId ?? null,
        normalizedChars: normalizeValueForRejection(content).length,
      });
      // SHORTCUT: scans every row of the tenant, fine for a human-run command; a digest column on memories if stores grow a hundredfold.
      const holdsValue: HoldsValue = (text) => rejectionDigest(text) === digest;
      removeLiveRows(db, hippoRoot, rejection, holdsValue, removal);
      removeDormantCopies(db, rejection, digest, holdsValue, removal);
      // Still inside the write scope: a failed audit row is reported and the reject commits without it.
      const { removedIds } = removal;
      audit(db, 'reject_value', { tenantId, actor, targetId: memoryId, metadata: { digest, removedIds, count: removedIds.length } });
    });

    purgeRemovedMirrors(db, hippoRoot, removal);

    const { removedIds, removedRawIds, successors, dormantSuccessorIds } = removal;
    return { digest, content, removedIds, removedRawIds, successorIds: successors.map((s) => s.id), dormantSuccessorIds };
  } finally {
    closeHippoDb(db);
  }
}

export type LiftedRejection =
  | { status: 'ok'; digest: string; reason: string | null }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: RejectedValueRow[] };

/** Deletes the tenant's one rejected value whose digest starts with `digestPrefix` and writes its unreject_value audit row.
 *  No match, or more than one, writes nothing. */
export function liftRejection(hippoRoot: string, tenantId: string, digestPrefix: string, actor: string): LiftedRejection {
  const db = openStore(hippoRoot);
  try {
    const matches = listRejectedValues(db, tenantId).filter((r) => r.digest.startsWith(digestPrefix));
    const target = matches[0];
    if (target === undefined) return { status: 'not_found' };
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches };

    deleteRejectedValue(db, tenantId, target.digest);
    audit(db, 'unreject_value', { tenantId, actor, targetId: target.sourceMemoryId ?? undefined, metadata: { digest: target.digest, reason: target.reason } });
    return { status: 'ok', digest: target.digest, reason: target.reason };
  } finally {
    closeHippoDb(db);
  }
}

/** The tenant's rejected values, newest first. */
export function loadRejectedValues(hippoRoot: string, tenantId: string): RejectedValueRow[] {
  const db = openStore(hippoRoot);
  try {
    return listRejectedValues(db, tenantId);
  } finally {
    closeHippoDb(db);
  }
}

/** Whether the write guard would refuse `content` under `entryId`, as a write of that row would find it. Reads on a plain open
 *  and writes nothing, so a dry run counts the values a real run refuses. */
export function rejectionGuardRefuses(hippoRoot: string, tenantId: string, entryId: string, content: string): boolean {
  const db = openHippoDb(hippoRoot);
  try {
    checkRejectionGuard(db, tenantId, entryId, content);
    return false;
  } catch (err) {
    if (err instanceof RejectedValueError) return true;
    throw err;
  } finally {
    closeHippoDb(db);
  }
}
