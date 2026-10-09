/**
 * Rejected-value tombstone: shared reject/unreject/list flow.
 *
 * The CLI (`hippo reject`/`rejections`/`unreject`) and the Context-based
 * `api.reject`/`api.unreject`/`api.listRejections` surfaces both need the
 * SAME multi-step transaction + post-commit mirror-purge flow. Extracted
 * here (leaf module) so neither duplicates it.
 *
 * Module direction: this file imports from store.ts, rejection.ts, raw-archive.ts,
 * dormant.ts, same-text.ts and merged-row.ts. Nothing imports FROM this file except
 * cli.ts and api.ts, so it introduces no cycle.
 */

import { closeHippoDb, withWriteScope, type DatabaseSyncLike } from './db.js';
import { BadRequestError } from './api-errors.js';
import { appendAuditEvent, reportAuditWriteFailure } from './audit.js';
import { isPersonalScope } from './recall-scope.js';
import { archiveRawMemory } from './raw-archive.js';
import { deleteDormantRow, listDormantSnapshots, purgeDormantByDigest, replaceDormantEntry } from './dormant.js';
import { stampOriginProject } from './store/entry-row.js';
import { purgeMirrorBestEffort } from './store/mirrors.js';
import { openStore } from './store/open.js';
import { writeEntryDbOnly, writeEntryMirrors } from './store/entry-writes.js';
import { selectAllEntries } from './store/entry-reads.js';
import { deleteEntryCore } from './store/delete-and-batch.js';
import type { MemoryEntry } from './memory.js';
import { heldTexts } from './same-text.js';
import { mergedSuccessor } from './merged-row.js';
import {
  rejectionDigest,
  normalizeValueForRejection,
  insertRejectedValue,
  deleteRejectedValue,
  listRejectedValues,
  type RejectedValueRow,
} from './rejection.js';

export interface RejectFlowOpts {
  hippoRoot: string;
  tenantId: string;
  actor: string;
  reason: string;
  /** By-id form: reject the CURRENT content of an existing memory. */
  memoryId?: string;
  /** Pre-emptive form: reject a value not currently stored (or already gone). */
  value?: string;
  /** The caller's own personal scope: the only personal rows the sweep may remove. Unset (the CLI) skips every personal row. */
  ownScope?: string;
}

export interface RejectFlowResult {
  digest: string;
  /** The rejected content, for the CLI's at-reject-time echo (the
   *  tombstone itself stores no content — this is the only place it's seen
   *  again after this call returns). */
  content: string;
  /** Every row removed this call, live or dormant: all whose normalized digest matched (not just the id
   *  passed, since duplicates share a digest), and each sleep-merged row holding the value, whose other
   *  texts move to a new row: listed in successorIds when it was live, dormantSuccessorIds when dormant. */
  removedIds: string[];
  /** Subset of removedIds that were kind='raw' (archived, not deleted). */
  removedRawIds: string[];
  successorIds: string[];
  dormantSuccessorIds: string[];
}

function assertRejectOpts(opts: RejectFlowOpts): void {
  if (!opts.reason.trim()) {
    throw new Error('reject requires a non-empty --reason (the tombstone stores no content; reason is its only identity).');
  }
  if (opts.memoryId === undefined && opts.value === undefined) {
    throw new Error('reject requires either a memory id or --value.');
  }
  if (opts.memoryId !== undefined && opts.value !== undefined) {
    // Enforced here, not only in the CLI parser, so a direct api caller passing both
    // is refused instead of silently getting the memoryId path with `value` ignored.
    throw new Error('reject accepts either a memory id or --value, not both.');
  }
  if (opts.value !== undefined && normalizeValueForRejection(opts.value).length === 0) {
    // Direct api callers can pass strings the CLI flag parser would have
    // refused; an empty-normalized tombstone would refuse nothing meaningful
    // and pollute the listing.
    throw new Error('reject --value requires non-empty content.');
  }
}

function contentToReject(db: DatabaseSyncLike, opts: RejectFlowOpts): string {
  if (opts.memoryId === undefined) return opts.value!;
  // SAFETY: row's shape matches the three columns named in the SELECT above.
  const row = db
    .prepare(`SELECT content, tenant_id, scope FROM memories WHERE id = ?`)
    .get(opts.memoryId) as { content: string; tenant_id: string; scope: string | null } | undefined;
  if (!row || row.tenant_id !== opts.tenantId) {
    throw new Error(`memory not found: ${opts.memoryId}`);
  }
  // A tombstone is tenant-wide, so one made from personal text would show its reason to everyone.
  if (isPersonalScope(row.scope)) throw new BadRequestError("Personal memories can't be rejected. Use forget to remove it.");
  return row.content;
}

/** Every row but another person's personal one, which is outside the caller's recall and so outside its reject. */
function inReach(opts: RejectFlowOpts, scope: string | null | undefined): boolean {
  return !isPersonalScope(scope) || scope === opts.ownScope;
}

/** What one reject removed and wrote, accumulated across the live and dormant passes. */
interface RejectRemoval {
  removedIds: string[];
  removedRawIds: string[];
  successors: MemoryEntry[];
  dormantSuccessorIds: string[];
}

type HoldsValue = (text: string) => boolean;

function removeLiveRows(db: DatabaseSyncLike, opts: RejectFlowOpts, holdsValue: HoldsValue, removal: RejectRemoval): void {
  const { removedIds, removedRawIds, successors } = removal;
  const merged: MemoryEntry[] = [];
  for (const row of selectAllEntries(db, opts.tenantId)) {
    if (!inReach(opts, row.scope)) continue;
    if (!holdsValue(row.content)) {
      if (heldTexts(row).some(holdsValue)) merged.push(row);
      continue;
    }
    if (row.kind === 'raw') {
      // Append-only trigger respected — archiveRawMemory is the only
      // legitimate removal path for kind='raw', and its inner SAVEPOINT
      // composes safely inside this BEGIN/COMMIT.
      archiveRawMemory(db, row.id, { reason: opts.reason, who: opts.actor });
      removedRawIds.push(row.id);
    } else {
      // suppressForgetAudit: the aggregate reject_value row below is the
      // trail for these removals, not N individual forget rows.
      deleteEntryCore(db, row.id, { actor: opts.actor, suppressForgetAudit: true });
    }
    removedIds.push(row.id);
  }
  for (const row of merged) {
    const successor = mergedSuccessor(row, holdsValue, new Set(removedIds));
    deleteEntryCore(db, row.id, { actor: opts.actor, suppressForgetAudit: true });
    removedIds.push(row.id);
    if (!successor) continue;
    const kept = stampOriginProject(opts.hippoRoot, successor);
    writeEntryDbOnly(db, kept, { actor: opts.actor });
    successors.push(kept);
  }
}

// Dormant copies (src/dormant.ts), whole or inside a merged row, go too, in the same transaction: a
// rejected value may not linger where `hippo dormant restore` could
// bring it back. They have no markdown mirror, so the post-commit
// mirror purge below is a no-op for them; they join removedIds for the
// audit trail and the caller's report.
function removeDormantCopies(db: DatabaseSyncLike, opts: RejectFlowOpts, digest: string, holdsValue: HoldsValue, removal: RejectRemoval): void {
  const { tenantId } = opts;
  const { removedIds, dormantSuccessorIds } = removal;
  removedIds.push(...purgeDormantByDigest(db, tenantId, digest, (scope) => inReach(opts, scope)));
  for (const dormant of listDormantSnapshots(db, tenantId)) {
    if (!inReach(opts, dormant.entry.scope)) continue;
    const successor = mergedSuccessor(dormant.entry, holdsValue, new Set(removedIds));
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

function auditRejectValue(db: DatabaseSyncLike, opts: RejectFlowOpts, digest: string, removedIds: string[]): void {
  try {
    appendAuditEvent(db, {
      tenantId: opts.tenantId,
      actor: opts.actor,
      op: 'reject_value',
      targetId: opts.memoryId,
      metadata: { digest, removedIds, count: removedIds.length },
    });
  } catch (error) {
    // Inside the open transaction: the reject commits without its trail row rather than rolling back over bookkeeping.
    reportAuditWriteFailure('reject_value', String(error), opts.memoryId);
  }
}

// Post-commit, db handle still open (same pattern as api.archiveRaw):
// best-effort mirror purge per removed id, reaper-backstop stamp for
// raw ids.
function purgeRemovedMirrors(db: DatabaseSyncLike, hippoRoot: string, removal: RejectRemoval): void {
  for (const id of removal.removedIds) {
    // purgeMirrorBestEffort retries once, then for non-raw ids (which the
    // reaper never scans) reports the EXPLICIT leftover path(s). See its own doc comment (store.ts, near
    // removeEntryMirrors) for the full rationale.
    const mirrorOk = purgeMirrorBestEffort(hippoRoot, id, removal.removedRawIds.includes(id), 'hippo reject');
    if (mirrorOk && removal.removedRawIds.includes(id)) {
      db.prepare(`UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(
        new Date().toISOString(),
        id,
      );
    }
  }
  for (const successor of removal.successors) writeEntryMirrors(hippoRoot, successor);
}

/**
 * `hippo reject` / `api.reject` core flow. ONE connection, one transaction:
 * insert the tombstone, enumerate + remove every live tenant row whose
 * normalized digest matches (kind-aware), one aggregate `reject_value`
 * audit, COMMIT. Then post-commit (mirrors the existing purge+reaper
 * pattern verbatim from api.archiveRaw, api.ts:1913-1938): best-effort
 * mirror purge per removed id, `mirror_cleaned_at` stamps for raw ids.
 * index.json itself is only refreshed by `rebuildIndex()`.
 */
export function rejectValue(opts: RejectFlowOpts): RejectFlowResult {
  assertRejectOpts(opts);

  const db = openStore(opts.hippoRoot);
  try {
    const content = contentToReject(db, opts);
    const digest = rejectionDigest(content);
    const now = new Date().toISOString();
    const removal: RejectRemoval = { removedIds: [], removedRawIds: [], successors: [], dormantSuccessorIds: [] };

    withWriteScope(db, 'reject_value', () => {
      insertRejectedValue(db, {
        tenantId: opts.tenantId,
        digest,
        reason: opts.reason,
        rejectedBy: opts.actor,
        rejectedAt: now,
        sourceMemoryId: opts.memoryId ?? null,
        normalizedChars: normalizeValueForRejection(content).length,
      });

      // O(N) scan over the tenant's rows (plan §4): human-triggered command
      // on ~1-5k-row stores — acceptable, documented. A digest column on
      // memories is the escape if stores grow 100x; not needed now.
      const holdsValue = (text: string): boolean => rejectionDigest(text) === digest;
      removeLiveRows(db, opts, holdsValue, removal);
      removeDormantCopies(db, opts, digest, holdsValue, removal);
      auditRejectValue(db, opts, digest, removal.removedIds);
    });

    purgeRemovedMirrors(db, opts.hippoRoot, removal);

    const { removedIds, removedRawIds, successors, dormantSuccessorIds } = removal;
    return { digest, content, removedIds, removedRawIds, successorIds: successors.map((s) => s.id), dormantSuccessorIds };
  } finally {
    closeHippoDb(db);
  }
}

export type UnrejectOutcome =
  | { status: 'ok'; digest: string; reason: string | null }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: RejectedValueRow[] };

/**
 * `hippo unreject` / `api.unreject` — resolve a unique tombstone by digest
 * (or prefix), delete it, audit `unreject_value`. The only v1 escape hatch
 * (plan §4): no per-write force flag.
 */
export function unrejectValue(
  hippoRoot: string,
  tenantId: string,
  digestOrPrefix: string,
  actor: string,
): UnrejectOutcome {
  // An empty/blank prefix startsWith-matches EVERY digest and would list the whole
  // tombstone set as ambiguous, so reject it before the DB round trip.
  if (digestOrPrefix.trim().length === 0) {
    return { status: 'not_found' };
  }

  const db = openStore(hippoRoot);
  try {
    const all = listRejectedValues(db, tenantId);
    const matches = all.filter((r) => r.digest.startsWith(digestOrPrefix));
    if (matches.length === 0) return { status: 'not_found' };
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches };

    const target = matches[0]!;
    deleteRejectedValue(db, tenantId, target.digest);
    try {
      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'unreject_value',
        targetId: target.sourceMemoryId ?? undefined,
        metadata: { digest: target.digest, reason: target.reason },
      });
    } catch (error) {
      reportAuditWriteFailure('unreject_value', String(error), target.sourceMemoryId);
    }
    return { status: 'ok', digest: target.digest, reason: target.reason };
  } finally {
    closeHippoDb(db);
  }
}

/** `hippo rejections` / `api.listRejections` — list tombstones for a tenant. */
export function listRejectionsForTenant(hippoRoot: string, tenantId: string): RejectedValueRow[] {
  const db = openStore(hippoRoot);
  try {
    return listRejectedValues(db, tenantId);
  } finally {
    closeHippoDb(db);
  }
}
