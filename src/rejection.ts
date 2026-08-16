/**
 * AT1 rejected-value tombstone — core invariant.
 * docs/plans/2026-08-15-at1-rejected-value-tombstone.md
 *
 * Exact-normalized-value semantics: a human who rejects a fact can refuse
 * byte-stable re-ingestion of the same value across remember/capture/import/
 * sync surfaces. Paraphrase/semantic matching is explicitly out of scope
 * (documented limitation, plan "Design").
 *
 * Kept db-agnostic (helpers take a `DatabaseSyncLike` handle) and does NOT
 * import from store.ts — store.ts imports from here, and the reverse would
 * be a cycle.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSyncLike } from './db.js';

/**
 * Normalize content for rejection-digest comparisons: Unicode NFC →
 * lowercase → collapse whitespace runs to a single space → trim. No
 * punctuation stripping — over-normalization creates false refusals, which
 * are worse than misses (plan §1).
 */
export function normalizeValueForRejection(content: string): string {
  return content.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Full sha256 hex (64 chars) of the normalized content. Reuses the strong-
 * identity convention (importers.ts:814 content-hash tag), NOT the privacy-
 * lossy 16-char convention (recall-trace query hashing) — a tombstone lookup
 * key needs collision resistance, not redaction (plan §1).
 */
export function rejectionDigest(content: string): string {
  return createHash('sha256').update(normalizeValueForRejection(content)).digest('hex');
}

/**
 * Thrown by the write-path guard (checkRejectionGuard, called from
 * upsertEntryRow) when an incoming write would introduce a value matching a
 * tombstoned digest. Carries enough context for the transaction-owner catch
 * blocks (writeEntry, api.supersede) to write a post-rollback
 * `reject_refusal` audit row via `auditRejectionRefusal` (plan §3).
 */
export class RejectedValueError extends Error {
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
      `Memory value refused: matches a rejected value (digest ${opts.digest.slice(0, 12)}..., ` +
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

/**
 * Look up a tombstone by tenant + digest. One indexed point query — the
 * guard's common-case cost, a miss ends the guard (plan §3).
 */
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

/**
 * Insert (or refresh) a tombstone row. Caller owns the transaction — used by
 * the T2 `reject` verb and `resolveConflict`'s `rejectLoserValue` path.
 */
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

/**
 * Delete a tombstone by tenant + exact digest — the T2 `unreject` verb, the
 * only v1 escape hatch (plan §4).
 */
export function deleteRejectedValue(db: DatabaseSyncLike, tenantId: string, digest: string): boolean {
  const result = db.prepare(`DELETE FROM rejected_values WHERE tenant_id = ? AND digest = ?`).run(tenantId, digest);
  return (result.changes ?? 0) > 0;
}

/** List tombstones for a tenant, newest first — the T2 `rejections` verb. */
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

/**
 * The write-path guard's check helper, called from `upsertEntryRow`
 * (store.ts). Fires when the incoming content's digest matches a tombstone
 * AND the write *introduces* that content: the row is new, OR the stored
 * row's content digest differs from the incoming one — an UPSERT editing a
 * same-id row TO a rejected value is a content introduction and must be
 * refused. Unchanged same-id re-persists (recall boost, decay, star toggle)
 * are exempt by construction (plan §3).
 *
 * Ordering minimizes queries on the common (miss) path: (a) caller has
 * already computed nothing yet — this does the digest + point lookup first;
 * (b) a miss returns immediately (ONE indexed point query); (c) only on a
 * tombstone hit does it SELECT the stored row's content to classify
 * new-row vs content-introduction (+1 query, rare path).
 */
export function checkRejectionGuard(
  db: DatabaseSyncLike,
  tenantId: string,
  entryId: string,
  content: string,
): void {
  const incomingDigest = rejectionDigest(content);
  const tombstone = findRejectedValue(db, tenantId, incomingDigest);
  if (!tombstone) return; // miss ends the guard — the overwhelmingly common case

  // Deliberately id-only (no tenant filter): memory ids are globally unique
  // ULIDs, this lookup only classifies new-row vs same-id re-persist for the
  // id the caller is already writing, and the tombstone lookup above is the
  // tenant-scoped decision. Matches deleteEntry's own by-id SELECT.
  //
  // P2 fix: also read tenant_id. Content-digest-only comparison let a
  // same-id upsert that ONLY changes tenantId slip through as an "unchanged
  // re-persist" — content C sitting quietly (never rejected) in tenant A
  // could be re-tagged into tenant B, and since C's digest already matched
  // this row's stored digest, the guard exempted it even though B is the
  // tenant that rejected C (that is WHY `tombstone` above is non-null: the
  // lookup already ran under the INCOMING/destination tenantId). A tenant
  // change on the SAME id is therefore always a content introduction into
  // the destination tenant, exactly as if the row were new there.
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
