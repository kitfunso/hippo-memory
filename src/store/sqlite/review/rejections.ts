import { withWriteScope, type DatabaseSyncLike } from '../../../db/index.js';
import type { MemoryEntry } from '../../../base/memory/entry.js';
import { heldTexts, identityText } from '../../../base/util/same-text.js';
import { audit } from '../audit/audit-event.js';
import { deleteEntryCore } from '../entries/delete-and-batch.js';
import {
  deleteDormantRow,
  dormantSnapshotsByIds,
  dormantTextsByIds,
  dormantTextsPage,
  replaceDormantEntry,
} from '../dormant/dormant-rows.js';
import { entryRejectRow, readEntriesByIds, listTenantTextsPage } from '../entries/entry-reads.js';
import { stampOriginProject } from '../entries/entry-row.js';
import { writeEntryDbOnly, writeEntryMirrors } from '../entries/entry-writes.js';
import { purgeMirrorBestEffort } from '../folder-files/mirrors.js';
import type { Handles, StoreFiles } from '../runtime/open.js';
import { archiveRawMemory, markMirrorCleaned } from '../entries/raw-archive.js';
import {
  deleteRejectedValue,
  insertRejectedValue,
  listRejectedValues,
  checkRejectionGuard,
} from './rejection.js';
import {
  normalizeValueForRejection,
  rowDigests,
  tombstoneDigest,
} from '../../../base/records/rejection-digest.js';
import type {
  AppliedRejection,
  LiftedRejection,
  Rejection,
  RejectionCheck,
  Rejections,
} from '../../../base/ports/store/rejections.js';
import { mergedSuccessor } from '../../../base/memory/merged-row.js';
import { rejectedText, rejectionReaches } from '../../../base/records/rejection-text.js';
import { RejectedValueError } from '../../../base/errors/api-errors.js';
import { openStore } from '../runtime/handles.js';
import { bound } from '../runtime/bound.js';
import type { EntryCursor } from '../../../base/ports/store/types.js';
import { READ_PAGE_ROWS } from '../../../base/util/pages.js';
import { handleStamp } from '../runtime/handle-clock.js';

type HoldsValue = (text: string, leadIn?: string | null) => boolean;

interface Removal {
  removedIds: string[];
  removedRawIds: string[];
  successors: MemoryEntry[];
  dormantSuccessorIds: string[];
}

interface Holders {
  readonly live: { readonly whole: MemoryEntry[]; readonly merged: MemoryEntry[] };
  readonly dormant: { readonly whole: string[]; readonly merged: string[] };
}

function holdOf(
  row: { content: string; leadIn?: string | null; source: string | null },
  holdsValue: HoldsValue,
): 'whole' | 'merged' | null {
  if (holdsValue(row.content, row.leadIn)) return 'whole';
  return heldTexts({ content: row.content, source: row.source ?? '' }).some((t) => holdsValue(t))
    ? 'merged'
    : null;
}

function listHolderIds(
  db: DatabaseSyncLike,
  rejection: Rejection,
  holdsValue: HoldsValue,
): string[] {
  const { tenantId } = rejection;
  const found: string[] = [];
  const keep = (row: {
    id: string;
    content: string;
    lead_in: string | null;
    source: string | null;
    scope: string | null;
  }): void => {
    const text = { content: row.content, leadIn: row.lead_in, source: row.source };
    if (rejectionReaches(rejection.ownScope, row.scope) && holdOf(text, holdsValue) !== null) {
      found.push(row.id);
    }
  };
  let after: EntryCursor | null = null;
  do {
    const page = listTenantTextsPage(db, tenantId, {
      limit: READ_PAGE_ROWS,
      after: after ?? undefined,
    });
    page.texts.forEach(keep);
    after = page.next;
  } while (after !== null);
  for (let afterId = ''; ;) {
    const page = dormantTextsPage(db, tenantId, { limit: READ_PAGE_ROWS, afterId });
    page.forEach(keep);
    if (page.length < READ_PAGE_ROWS) return found;
    afterId = page[page.length - 1].id;
  }
}

function heldUnderLock(
  db: DatabaseSyncLike,
  rejection: Rejection,
  holdsValue: HoldsValue,
  ids: string[],
): Holders {
  const { tenantId, ownScope } = rejection;
  const inReach = (scope: string | null | undefined): boolean => rejectionReaches(ownScope, scope);
  const live = readEntriesByIds(db, ids, tenantId);
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
      if (row === undefined || !inReach(row.scope)) return false;
      const text = { content: row.content, leadIn: row.lead_in, source: row.source };
      return holdOf(text, holdsValue) === hold;
    });
  return {
    live: { whole: liveHolding('whole'), merged: liveHolding('merged') },
    dormant: { whole: dormantHolding('whole'), merged: dormantHolding('merged') },
  };
}

interface Sweep {
  readonly rejection: Rejection;
  readonly holdsValue: HoldsValue;
  readonly holders: Holders;
  readonly removal: Removal;
}

function removeLiveRows(db: DatabaseSyncLike, files: StoreFiles, sweep: Sweep): void {
  const { rejection, holdsValue, removal } = sweep;
  const { live } = sweep.holders;
  const { tenantId, actor, reason } = rejection;
  const { removedIds, removedRawIds, successors } = removal;
  for (const row of live.whole) {
    if (row.kind === 'raw') {
      archiveRawMemory(db, row.id, { reason, who: actor });
      removedRawIds.push(row.id);
    } else {
      deleteEntryCore(db, row.id, tenantId, { actor, suppressForgetAudit: true });
    }
    removedIds.push(row.id);
  }
  for (const row of live.merged) {
    const successor = mergedSuccessor(row, holdsValue, new Set(removedIds));
    deleteEntryCore(db, row.id, tenantId, { actor, suppressForgetAudit: true });
    removedIds.push(row.id);
    if (!successor) continue;
    const kept = stampOriginProject(files, successor);
    writeEntryDbOnly(db, kept, { actor });
    successors.push(kept);
  }
}

function removeDormantCopies(db: DatabaseSyncLike, sweep: Sweep): void {
  const { rejection, holdsValue, removal } = sweep;
  const { dormant } = sweep.holders;
  const { tenantId } = rejection;
  const { removedIds, dormantSuccessorIds } = removal;
  for (const id of dormant.whole) {
    deleteDormantRow(db, tenantId, id);
    removedIds.push(id);
  }
  const snapshots = dormantSnapshotsByIds(db, tenantId, dormant.merged);
  for (const id of dormant.merged) {
    const entry = snapshots.get(id)?.entry;
    const successor = entry && mergedSuccessor(entry, holdsValue, new Set(removedIds));
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

function purgeRemovedMirrors(db: DatabaseSyncLike, hippoRoot: string, removal: Removal): void {
  const rawIds = new Set(removal.removedRawIds);
  for (const id of removal.removedIds) {
    const isRaw = rawIds.has(id);
    const mirrorOk = purgeMirrorBestEffort(hippoRoot, { id, isRaw, logPrefix: 'hippo reject' });
    if (mirrorOk && isRaw) markMirrorCleaned(db, id, handleStamp(db));
  }
  for (const successor of removal.successors) writeEntryMirrors(hippoRoot, successor);
}

interface FoundHolders {
  readonly rejection: Rejection;
  readonly digest: string;
  readonly holdsValue: HoldsValue;
  readonly found: string[];
}

function removeHolders(
  db: DatabaseSyncLike,
  files: StoreFiles,
  { rejection, digest, holdsValue, found }: FoundHolders,
): Removal {
  const removal: Removal = {
    removedIds: [],
    removedRawIds: [],
    successors: [],
    dormantSuccessorIds: [],
  };
  withWriteScope(db, 'reject_value', () => {
    const sweep = {
      rejection,
      holdsValue,
      holders: heldUnderLock(db, rejection, holdsValue, found),
      removal,
    };
    removeLiveRows(db, files, sweep);
    removeDormantCopies(db, sweep);
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

function applyRejection(
  db: DatabaseSyncLike,
  files: StoreFiles,
  rejection: Rejection,
): AppliedRejection {
  const { hippoRoot } = files;
  const { tenantId, actor, reason, memoryId } = rejection;
  const row = memoryId === undefined ? undefined : entryRejectRow(db, memoryId);
  const content = rejectedText(rejection, row);
  const leadIn = row?.lead_in || null;
  const digest = tombstoneDigest({ content, leadIn });
  const rejectedAt = files.clock().toISOString();
  withWriteScope(db, 'reject_value_row', () =>
    insertRejectedValue(db, {
      tenantId,
      digest,
      reason,
      rejectedBy: actor,
      rejectedAt,
      sourceMemoryId: memoryId ?? null,
      normalizedChars: normalizeValueForRejection(identityText({ content, leadIn })).length,
    }),
  );
  // SHORTCUT: hashes every text of the tenant, a page at a time with no lock held; a digest column
  // needs a schema migration, held until approved.
  const holdsValue: HoldsValue = (text, lead) =>
    rowDigests({ content: text, leadIn: lead }).includes(digest);
  const found = listHolderIds(db, rejection, holdsValue);
  const removal = removeHolders(db, files, { rejection, digest, holdsValue, found });

  purgeRemovedMirrors(db, hippoRoot, removal);

  const { removedIds, removedRawIds, successors, dormantSuccessorIds } = removal;
  return {
    digest,
    content,
    removedIds,
    removedRawIds,
    successorIds: successors.map((s) => s.id),
    dormantSuccessorIds,
    leadInOnly: leadIn !== null,
  };
}

function liftRejection(
  db: DatabaseSyncLike,
  tenantId: string,
  digestPrefix: string,
  actor: string,
): LiftedRejection {
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

export function refusedAmong(db: DatabaseSyncLike, checks: readonly RejectionCheck[]): boolean[] {
  return checks.map(({ tenantId, entryId, content, leadIn }) => {
    try {
      checkRejectionGuard(db, { tenantId, entryId, content, leadIn });
      return false;
    } catch (err) {
      if (err instanceof RejectedValueError) return true;
      throw err;
    }
  });
}

export function sqliteRejections({ on, files }: Handles): Rejections {
  return {
    ...bound<Pick<Rejections, 'apply'>>(
      on,
      { apply: (db, ...args) => applyRejection(db, files, ...args) },
      openStore,
    ),
    ...bound<Pick<Rejections, 'lift' | 'list'>>(
      on,
      { lift: liftRejection, list: listRejectedValues },
      openStore,
    ),
    ...bound<Pick<Rejections, 'refusedAmong'>>(on, { refusedAmong: refusedAmong }),
  };
}
