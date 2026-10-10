/** Rejected-value tombstone: a human can refuse byte-stable re-ingestion of a rejected fact (exact normalized value); paraphrase matching is out of scope.
 * db-agnostic (helpers take a `DatabaseSyncLike`) and imports nothing from the store layer above it, which imports this (the reverse is a cycle). */

import { createHash } from 'node:crypto';
import type { DatabaseSyncLike } from '../db/index.js';
import { BadRequestError } from '../core/api-errors.js';
import { DIGEST_DISPLAY_CHARS } from '../util/token-text.js';

/** Normalize content for rejection digests: NFC, lowercase, collapse whitespace runs, trim. No punctuation stripping: over-normalizing causes false
 * refusals, worse than misses. */
export function normalizeValueForRejection(content: string): string {
  return content.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Full 64-char sha256 hex of the normalized content: a tombstone key needs collision resistance, not the 16-char redaction hash used for query hashing. */
export function rejectionDigest(content: string): string {
  return createHash('sha256').update(normalizeValueForRejection(content)).digest('hex');
}

/** Thrown by the write-path guard (checkRejectionGuard, via upsertEntryRow) when a write would introduce a tombstoned value; carries what the
 * transaction-owner catch blocks (writeEntry, api.supersede) need to write the post-rollback `reject_refusal` audit row via `auditRejectionRefusal`. */
export class RejectedValueError extends BadRequestError {
  readonly digest: string;
  readonly tenantId: string;
  readonly entryId: string;
  readonly reason: string | null;
  readonly rejectedAt: string;

  constructor(opts: {
    digest: string;
    tenantId: string;
    entryId: string;
    reason: string | null;
    rejectedAt: string;
  }) {
    super(
      `Memory value refused: matches a rejected value (digest ${opts.digest.slice(0, DIGEST_DISPLAY_CHARS)}..., ` +
        `reason: ${opts.reason ?? 'none given'}). Run "hippo unreject" to allow it again.`,
    );
    this.name = 'RejectedValueError';
    this.digest = opts.digest;
    this.tenantId = opts.tenantId;
    this.entryId = opts.entryId;
    this.reason = opts.reason;
    this.rejectedAt = opts.rejectedAt;
  }
}

export interface RejectedValueRow {
  tenantId: string;
  digest: string;
  reason: string | null;
  rejectedBy: string | null;
  rejectedAt: string;
  sourceMemoryId: string | null;
  normalizedChars: number | null;
}

interface RawRejectedValueRow {
  tenant_id: string;
  digest: string;
  reason: string | null;
  rejected_by: string | null;
  rejected_at: string;
  source_memory_id: string | null;
  normalized_chars: number | null;
}

function rowToRejectedValue(row: RawRejectedValueRow): RejectedValueRow {
  return {
    tenantId: row.tenant_id,
    digest: row.digest,
    reason: row.reason,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    sourceMemoryId: row.source_memory_id,
    normalizedChars: row.normalized_chars,
  };
}

/** Look up a tombstone by tenant + digest: one indexed point query, the guard's common-case cost; a miss ends the guard. */
export function findRejectedValue(
  db: DatabaseSyncLike,
  tenantId: string,
  digest: string,
): RejectedValueRow | null {
  // SAFETY: row's shape matches the columns named in the SELECT above.
  const row = db
    .prepare(
      `SELECT tenant_id, digest, reason, rejected_by, rejected_at, source_memory_id, normalized_chars
       FROM rejected_values WHERE tenant_id = ? AND digest = ?`,
    )
    .get(tenantId, digest) as RawRejectedValueRow | undefined;
  return row ? rowToRejectedValue(row) : null;
}

/** Insert (or refresh) a tombstone row; the caller owns the transaction (used by the `reject` verb and `resolveConflict`'s `rejectLoserValue`). */
export function insertRejectedValue(
  db: DatabaseSyncLike,
  opts: {
    tenantId: string;
    digest: string;
    reason: string;
    rejectedBy: string;
    rejectedAt: string;
    sourceMemoryId?: string | null;
    normalizedChars: number;
  },
): void {
  db.prepare(
    `INSERT INTO rejected_values(tenant_id, digest, reason, rejected_by, rejected_at, source_memory_id, normalized_chars)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, digest) DO UPDATE SET
       reason = excluded.reason,
       rejected_by = excluded.rejected_by,
       rejected_at = excluded.rejected_at,
       source_memory_id = excluded.source_memory_id,
       normalized_chars = excluded.normalized_chars`,
  ).run(
    opts.tenantId,
    opts.digest,
    opts.reason,
    opts.rejectedBy,
    opts.rejectedAt,
    opts.sourceMemoryId ?? null,
    opts.normalizedChars,
  );
}

/** Delete a tombstone by tenant + exact digest: the `unreject` verb, the only escape hatch. */
export function deleteRejectedValue(db: DatabaseSyncLike, tenantId: string, digest: string): boolean {
  const result = db.prepare(`DELETE FROM rejected_values WHERE tenant_id = ? AND digest = ?`).run(tenantId, digest);
  return (result.changes ?? 0) > 0;
}

/** List tombstones for a tenant, newest first: the `rejections` verb. */
export function listRejectedValues(db: DatabaseSyncLike, tenantId: string): RejectedValueRow[] {
  // SAFETY: rows' shape matches the columns named in the SELECT above.
  const rows = db
    .prepare(
      `SELECT tenant_id, digest, reason, rejected_by, rejected_at, source_memory_id, normalized_chars
       FROM rejected_values WHERE tenant_id = ? ORDER BY rejected_at DESC, digest ASC`,
    )
    .all(tenantId) as RawRejectedValueRow[];
  return rows.map(rowToRejectedValue);
}

/** Write-path guard check: fires when the digest matches a tombstone AND the write introduces that content (a new row, or a same-id UPSERT changing it).
 * Unchanged same-id re-persists (recall boost, decay, star toggle) are exempt. A miss costs ONE indexed point query; only a hit SELECTs the stored row. */
export function checkRejectionGuard(
  db: DatabaseSyncLike,
  tenantId: string,
  entryId: string,
  content: string,
): void {
  const incomingDigest = rejectionDigest(content);
  const tombstone = findRejectedValue(db, tenantId, incomingDigest);
  if (!tombstone) return; // miss ends the guard — the overwhelmingly common case

  // Id-only on purpose (ids are global ULIDs; the tombstone lookup is tenant-scoped); tenant_id is read as a tenantId-only upsert introduces content there.
  // SAFETY: storedRow's shape matches the two columns named in the SELECT above.
  const storedRow = db.prepare(`SELECT content, tenant_id FROM memories WHERE id = ?`).get(entryId) as
    | { content: string; tenant_id: string }
    | undefined;
  const isNewRow = storedRow === undefined;
  const tenantChanged = !isNewRow && storedRow.tenant_id !== tenantId;
  const isContentIntroduction =
    isNewRow || tenantChanged || rejectionDigest(storedRow.content) !== incomingDigest;
  if (!isContentIntroduction) return; // unchanged same-id re-persist — exempt by construction

  throw new RejectedValueError({
    digest: incomingDigest,
    tenantId,
    entryId,
    reason: tombstone.reason,
    rejectedAt: tombstone.rejectedAt,
  });
}
