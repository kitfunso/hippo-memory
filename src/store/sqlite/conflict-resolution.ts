// hippo.db's conflict resolve: keeps one side and weakens, removes or rejects the other.
import { DEFAULT_TENANT_ID } from '../../base/util/tenant.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { insertRejectedValue } from './rejection.js';
import {
  contentDigests,
  rejectionDigest,
  normalizeValueForRejection,
} from '../../base/records/rejection-digest.js';
import { onlyRedacted, redactSecretsStrict } from '../../base/util/secret-detect.js';
import { archiveRawMemory } from './raw-archive.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { digestHolderPages } from './text-digests.js';
import { parseJsonArray } from './rows.js';
import { audit } from './audit-event.js';
import { syncChangedMirrors, purgeMirrorBestEffort } from './mirrors.js';
import { readEntriesByIds } from './entry-reads.js';
import { ownScopeTouches } from '../../base/scope/recall-scope.js';
import type { StoreFiles } from './open.js';
import { deleteEntryCore } from './entry-deletes.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type { ConflictResolution, LoserFate } from '../../base/ports/store/conflicts.js';
import { handleStamp } from './handle-clock.js';
/** Metadata shape of the `conflict_resolve` audit row; rejectedDigest is set only when the
 * loser's value was also tombstoned. */
interface ConflictResolveMeta {
  conflictId: number;
  keepId: string;
  loserId: string;
  disposition: string;
  rejected: boolean;
  removedIds: string[];
  rejectedDigest?: string;
  tombstoneSkipped?: 'all-secret';
}

// A side still in the tenant and still holding the scope the api decided on.
const SIDE_HOLDS = 'EXISTS (SELECT 1 FROM memories WHERE id = ? AND tenant_id = ? AND scope IS ?)';

/**
 * Marks the conflict resolved while it is open, names this pair and each side holds its scope;
 * false writes nothing.
 */
function claimConflict(
  db: DatabaseSyncLike,
  tenantId: string,
  resolution: ConflictResolution,
): boolean {
  const { conflictId, keep, loser } = resolution;
  const pair = [keep.id, loser.id, loser.id, keep.id];
  const sides = [keep.id, tenantId, keep.scope, loser.id, tenantId, loser.scope];
  const claimed = cachedStatement(
    db,
    `UPDATE memory_conflicts SET status = 'resolved', updated_at = ? WHERE id = ? AND status = 'open' AND ` +
      `((memory_a_id = ? AND memory_b_id = ?) OR (memory_a_id = ? AND memory_b_id = ?)) AND ${SIDE_HOLDS} AND ` +
      `${SIDE_HOLDS}`,
  ).run(resolution.at, conflictId, ...pair, ...sides);
  return Number(claimed.changes ?? 0) > 0;
}

/** Keeps `keep` and weakens, removes or rejects `loser` as the api decided, with one
 * `conflict_resolve` audit row; false when another resolver got there first or a side moved
 * since the api read it. */
export function resolveConflict(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  resolution: ConflictResolution,
): boolean {
  const removal = withWriteScope(db, 'resolve_conflict', () => {
    if (!claimConflict(db, tenantId, resolution)) return null;
    const { fate } = resolution;
    const out =
      fate.kind === 'weaken'
        ? weakenConflictLoser(db, tenantId, resolution.loser.id, fate)
        : removeConflictLoser(db, tenantId, resolution);
    stripConflictRefs(db, tenantId, resolution, out.loserRemoved);
    auditConflictResolve(db, tenantId, resolution, out);
    return out;
  });
  if (removal === null) return false;
  const { keep, loser } = resolution;
  const changed = [...readEntriesByIds(db, [keep.id, loser.id], tenantId).values()];
  syncChangedMirrors(files, db, changed, resolution.at);
  if (removal.loserRemoved) purgeRemovedLoserMirrors(files.hippoRoot, db, loser.id, removal);
  return true;
}

/** What removing the loser did; drives the conflicts_with_json skip, the audit row and the
 * mirror purge. */
interface LoserRemoval {
  loserRemoved: boolean;
  loserWasRaw: boolean;
  rejectedDigest: string | undefined;
  /** The loser's stored text was redaction markers alone, so no tombstone was written. */
  tombstoneSkipped: boolean;
  extraRemovedIds: string[];
  extraRemovedRawIds: string[];
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface LoserRow {
  kind: string;
  content: string;
  tenant_id: string;
}

function emptyRemoval(): LoserRemoval {
  return {
    loserRemoved: false,
    loserWasRaw: false,
    rejectedDigest: undefined,
    tombstoneSkipped: false,
    extraRemovedIds: [],
    extraRemovedRawIds: [],
  };
}

type WeakenFate = Extract<LoserFate, { kind: 'weaken' }>;

function weakenConflictLoser(
  db: DatabaseSyncLike,
  tenantId: string,
  loserId: string,
  fate: WeakenFate,
): LoserRemoval {
  cachedStatement(
    db,
    `UPDATE memories SET half_life_days = MAX(?, half_life_days * ?), updated_at = datetime('now') ` +
      `WHERE id = ? AND tenant_id = ?`,
  ).run(fate.minHalfLifeDays, fate.halfLifeFactor, loserId, tenantId);
  return emptyRemoval();
}

function removeConflictLoser(
  db: DatabaseSyncLike,
  tenantId: string,
  r: ConflictResolution,
): LoserRemoval {
  // Removal is kind-aware: a bare DELETE on a raw loser fires the append-only trigger, so use the
  // same helpers as the reject verb.
  const removal = emptyRemoval();
  const loserId = r.loser.id;
  const loserRow = cachedStatement(
    db,
    `SELECT kind, content, tenant_id FROM memories WHERE id = ? AND tenant_id = ?`,
  ).get(loserId, tenantId) as LoserRow | undefined;
  // The claim in this transaction saw the row, so it is there.
  if (!loserRow) return removal;
  if (r.fate.kind === 'reject') {
    removal.rejectedDigest = tombstoneLoserValue(db, {
      r,
      ownScope: r.fate.ownScope,
      loserRow,
      removal,
    });
  }
  if (loserRow.kind === 'raw') {
    archiveRawMemory(db, loserId, { reason: r.reason, who: r.actor });
    removal.loserWasRaw = true;
  } else {
    deleteEntryCore(db, loserId, loserRow.tenant_id, { actor: r.actor, suppressForgetAudit: true });
  }
  removal.loserRemoved = true;
  return removal;
}

function recordRejectedLoserValue(
  db: DatabaseSyncLike,
  r: ConflictResolution,
  loserRow: LoserRow,
  digest: string,
): void {
  insertRejectedValue(db, {
    tenantId: loserRow.tenant_id ?? DEFAULT_TENANT_ID,
    digest,
    reason: r.reason,
    rejectedBy: r.actor,
    rejectedAt: r.at,
    sourceMemoryId: r.loser.id,
    normalizedChars: normalizeValueForRejection(redactSecretsStrict(loserRow.content)).length,
  });
}

/** A loser whose value is rejected: its row, the scope its duplicates are swept in, and the
 * removal they go into. */
interface RejectedLoser {
  readonly r: ConflictResolution;
  readonly ownScope: string | null;
  readonly loserRow: LoserRow;
  readonly removal: LoserRemoval;
}

// What the duplicate check reads of a row, so an unfilled candidate costs one read.
const DUP_COLUMNS = 'id, kind, content, scope';
type DupRow = Pick<MemoryEntry, 'id' | 'kind' | 'content' | 'scope'>;

/** Removes the live same-tenant rows `ownScope` may touch whose digest matches the rejected
 * value into `removal`; `keep` is spared. */
function removeDuplicatesOfRejectedValue(
  db: DatabaseSyncLike,
  { r, ownScope, loserRow, removal }: RejectedLoser,
  rejectedDigest: string,
): void {
  // Every live same-tenant row holding the value goes, as `hippo reject` does; `keep` stays because
  // the human chose it.
  const loserTenantId = loserRow.tenant_id ?? DEFAULT_TENANT_ID;
  const query = { tenantId: loserTenantId, digest: rejectedDigest, columns: DUP_COLUMNS };
  const skip = new Set([r.loser.id, r.keep.id]);
  const dups: Array<{ id: string; kind: string }> = [];
  for (const page of digestHolderPages<DupRow>(db, 'live', query, skip)) {
    const rows =
      'keyed' in page ? readEntriesByIds(db, page.keyed, loserTenantId).values() : page.unfilled;
    for (const dup of rows) {
      if (
        !contentDigests(dup.content).includes(rejectedDigest) ||
        !ownScopeTouches(ownScope, dup.scope)
      ) {
        continue;
      }
      dups.push({ id: dup.id, kind: dup.kind });
    }
  }
  const { actor, reason } = r;
  // Removed after the walk ends, so no delete changes the rows a later page of the walk reads.
  for (const dup of dups) {
    if (dup.kind === 'raw') {
      archiveRawMemory(db, dup.id, { reason, who: actor });
      removal.extraRemovedRawIds.push(dup.id);
    } else {
      deleteEntryCore(db, dup.id, loserTenantId, { actor, suppressForgetAudit: true });
    }
    removal.extraRemovedIds.push(dup.id);
  }
}

/** Tombstones the digest of the loser's stored text and removes its same-tenant duplicates into
 * `removal`; returns the digest, or undefined for a loser all secret, which names no value. */
function tombstoneLoserValue(db: DatabaseSyncLike, loser: RejectedLoser): string | undefined {
  const stored = redactSecretsStrict(loser.loserRow.content);
  if (onlyRedacted(stored)) {
    loser.removal.tombstoneSkipped = true;
    return undefined;
  }
  const rejectedDigest = rejectionDigest(stored);
  recordRejectedLoserValue(db, loser.r, loser.loserRow, rejectedDigest);
  removeDuplicatesOfRejectedValue(db, loser, rejectedDigest);
  return rejectedDigest;
}

/** A tenant's row `id` and the conflict id `ref` it drops. */
interface DropConflictRefOptions {
  readonly tenantId: string;
  readonly id: string;
  readonly ref: string;
}

/** Drops `ref` from row `id`'s conflicts_with_json, when the row is in the tenant. */
function dropConflictRef(
  db: DatabaseSyncLike,
  { tenantId, id, ref }: DropConflictRefOptions,
): void {
  const row = cachedStatement(
    db,
    `SELECT conflicts_with_json FROM memories WHERE id = ? AND tenant_id = ?`,
  ).get(id, tenantId) as { conflicts_with_json: string } | undefined;
  if (!row) return;
  const refs = parseJsonArray(row.conflicts_with_json, {
    table: 'memories',
    id,
    column: 'conflicts_with_json',
  });
  cachedStatement(
    db,
    `UPDATE memories SET conflicts_with_json = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`,
  ).run(JSON.stringify(refs.filter((r: string) => r !== ref)), id, tenantId);
}

function stripConflictRefs(
  db: DatabaseSyncLike,
  tenantId: string,
  r: ConflictResolution,
  loserRemoved: boolean,
): void {
  dropConflictRef(db, { tenantId, id: r.keep.id, ref: r.loser.id });
  if (!loserRemoved) dropConflictRef(db, { tenantId, id: r.loser.id, ref: r.keep.id });
}

function auditConflictResolve(
  db: DatabaseSyncLike,
  tenantId: string,
  r: ConflictResolution,
  removal: LoserRemoval,
): void {
  const { loserRemoved, loserWasRaw, rejectedDigest, extraRemovedIds } = removal;
  // Every path (weaken, forget, reject) lands exactly one conflict_resolve audit row.
  const conflictResolveMeta: ConflictResolveMeta = {
    conflictId: r.conflictId,
    keepId: r.keep.id,
    loserId: r.loser.id,
    disposition: loserRemoved ? (loserWasRaw ? 'archived_raw' : 'deleted') : 'weakened',
    rejected: r.fate.kind === 'reject',
    // Every row this call removed, not just loserId, so the duplicate sweep (extraRemovedIds) is
    // audited too.
    removedIds: loserRemoved ? [r.loser.id, ...extraRemovedIds] : [],
  };
  // Assigned only when present so the serialized audit payload keeps omitting the key, exactly as
  // the pre-migration object literal did.
  if (rejectedDigest !== undefined) conflictResolveMeta.rejectedDigest = rejectedDigest;
  if (removal.tombstoneSkipped) conflictResolveMeta.tombstoneSkipped = 'all-secret';
  // Fresh spread literal: ConflictResolveMeta is a closed interface, not assignable to audit()'s
  // Record<string, JsonValue> metadata otherwise.
  audit(db, 'conflict_resolve', {
    targetId: r.keep.id,
    metadata: { ...conflictResolveMeta },
    actor: r.actor,
    tenantId,
  });
}

function purgeRemovedLoserMirrors(
  hippoRoot: string,
  db: DatabaseSyncLike,
  loserId: string,
  removal: LoserRemoval,
): void {
  // Mirror purge and reaper stamp for EVERY removed loser (loserId and each extraRemovedIds
  // duplicate), post-commit like the reject verb. A non-raw mirror has no reaper, so skipping the
  // purge would orphan it forever.
  for (const removedId of [loserId, ...removal.extraRemovedIds]) {
    const isRaw =
      removedId === loserId ? removal.loserWasRaw : removal.extraRemovedRawIds.includes(removedId);
    // purgeMirrorBestEffort retries once, then reports the explicit leftover paths for non-raw ids,
    // which the cleanupArchivedMirrors reaper never scans.
    const purge = { id: removedId, isRaw, logPrefix: 'resolveConflict' };
    const mirrorOk = purgeMirrorBestEffort(hippoRoot, purge);
    if (mirrorOk && isRaw) {
      cachedStatement(db, `UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(
        handleStamp(db),
        removedId,
      );
    }
  }
}

/** The conflict and loser ids every conflict_resolve audit row names. */
export function conflictResolveAudits(
  db: DatabaseSyncLike,
): Array<{ conflictId: number; loserId: string }> {
  // SAFETY: every conflict_resolve audit row's metadata holds both ids (ConflictResolveMeta above).
  return cachedStatement(
    db,
    `SELECT json_extract(metadata_json, '$.conflictId') ` +
      `AS conflictId, json_extract(metadata_json, '$.loserId') AS loserId ` +
      `FROM audit_log WHERE op = 'conflict_resolve'`,
  ).all() as { conflictId: number; loserId: string }[];
}

/** Every resolved conflict with both sides. */
export function resolvedConflicts(
  db: DatabaseSyncLike,
): Array<{ id: number; memory_a_id: string; memory_b_id: string }> {
  return cachedStatement(
    db,
    `SELECT id, memory_a_id, memory_b_id FROM memory_conflicts WHERE status = 'resolved'`,
  ).all() as {
    id: number;
    memory_a_id: string;
    memory_b_id: string;
  }[];
}
