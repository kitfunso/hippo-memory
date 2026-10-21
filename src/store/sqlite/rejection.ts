/** Rejected-value tombstone: a human can refuse byte-stable re-ingestion of a rejected fact (exact normalized value);
 * paraphrase matching is out of scope. db-agnostic (helpers take a `DatabaseSyncLike`) and imports nothing from the
 * store layer above it, which imports this (the reverse is a cycle). */

import { rejectionDigest } from '../../base/records/rejection-digest.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import type { RejectedValueRow } from '../port/rejections.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { chunked } from '../../base/util/chunked.js';
import { orderSql, REJECTED_ORDER } from '../rules/order.js';

// SAFETY: every read cast to this row selects REJECTED_VALUE_COLUMNS; scripts/check-row-casts.mjs proves it.
interface RawRejectedValueRow {
  tenant_id: string;
  digest: string;
  reason: string | null;
  rejected_by: string | null;
  rejected_at: string;
  source_memory_id: string | null;
  normalized_chars: number | null;
}
const REJECTED_VALUE_COLUMNS =
  'tenant_id, digest, reason, rejected_by, rejected_at, source_memory_id, normalized_chars';

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

/** Look up a tombstone by tenant + digest: one indexed point query, the guard's common-case cost; a miss ends the
 * guard. */
export function findRejectedValue(db: DatabaseSyncLike, tenantId: string, digest: string): RejectedValueRow | null {
  const row = cachedStatement(
    db,
    `SELECT ${REJECTED_VALUE_COLUMNS}
       FROM rejected_values WHERE tenant_id = ? AND digest = ?`,
  ).get(tenantId, digest) as RawRejectedValueRow | undefined;
  return row ? rowToRejectedValue(row) : null;
}

/** The tenant's tombstones among `digests`, by digest, in chunked IN lists on the primary key. */
export function rejectedValuesAt(
  db: DatabaseSyncLike,
  tenantId: string,
  digests: readonly string[],
): Map<string, RejectedValueRow> {
  const found = new Map<string, RejectedValueRow>();
  for (const chunk of chunked([...new Set(digests)])) {
    const rows = cachedStatement(
      db,
      `SELECT ${REJECTED_VALUE_COLUMNS} FROM rejected_values ` +
        'WHERE tenant_id = ? AND digest IN (SELECT value FROM json_each(?))',
    ).all(tenantId, JSON.stringify(chunk)) as RawRejectedValueRow[];
    for (const row of rows) found.set(row.digest, rowToRejectedValue(row));
  }
  return found;
}

/** The digests among `digests` the tenant holds a tombstone for. */
export function rejectedDigestsAt(db: DatabaseSyncLike, tenantId: string, digests: readonly string[]): Set<string> {
  return new Set(rejectedValuesAt(db, tenantId, digests).keys());
}

/** Insert (or refresh) a tombstone row; the caller owns the transaction (used by the `reject` verb and
 * `resolveConflict`'s `rejectLoserValue`). */
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
  cachedStatement(
    db,
    `INSERT INTO rejected_values(tenant_id, digest, reason, rejected_by, rejected_at, source_memory_id, ` +
      `normalized_chars)
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
  const result = cachedStatement(db, `DELETE FROM rejected_values WHERE tenant_id = ? AND digest = ?`).run(
    tenantId,
    digest,
  );
  return (result.changes ?? 0) > 0;
}

/** List tombstones for a tenant, newest first: the `rejections` verb. */
export function listRejectedValues(db: DatabaseSyncLike, tenantId: string): RejectedValueRow[] {
  const rows = cachedStatement(
    db,
    `SELECT ${REJECTED_VALUE_COLUMNS}
       FROM rejected_values WHERE tenant_id = ? ORDER BY ${orderSql(REJECTED_ORDER)}`,
  ).all(tenantId) as RawRejectedValueRow[];
  return rows.map(rowToRejectedValue);
}

/** Write-path guard check: fires when the digest matches a tombstone AND the write introduces that content (a new row,
 * or a same-id UPSERT changing it). Unchanged same-id re-persists (recall boost, decay, star toggle) are exempt. A miss
 * costs ONE indexed point query; only a hit SELECTs the stored row. */
export function checkRejectionGuard(db: DatabaseSyncLike, tenantId: string, entryId: string, content: string): void {
  const incomingDigest = rejectionDigest(content);
  const tombstone = findRejectedValue(db, tenantId, incomingDigest);
  if (!tombstone) return; // miss ends the guard — the overwhelmingly common case

  // Id-only on purpose (ids are global ULIDs; the tombstone lookup is tenant-scoped); tenant_id is read as a
  // tenantId-only upsert introduces content there.
  const storedRow = cachedStatement(db, `SELECT content, tenant_id FROM memories WHERE id = ?`).get(entryId) as
    | StoredContentRow
    | undefined;
  // An unchanged same-id re-persist (recall boost, decay, star toggle) is exempt.
  if (!introducesContent(storedRow, tenantId, incomingDigest)) return;
  throw rejectedValueError(tombstone, entryId);
}

/** The columns of the row an id holds now that say whether a write to it introduces content. */
// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface StoredContentRow {
  readonly content: string;
  readonly tenant_id: string | null;
}

/** True when writing content of `digest` under `tenantId` over `stored`, the row the id holds now, introduces it: a new
 * row, a move to the tenant, or changed content. The guard refuses only these. */
export function introducesContent(stored: StoredContentRow | undefined, tenantId: string, digest: string): boolean {
  return stored === undefined || stored.tenant_id !== tenantId || rejectionDigest(stored.content) !== digest;
}

/** The refusal of a write to `entryId` that `tombstone` matched. */
function rejectedValueError(tombstone: RejectedValueRow, entryId: string): RejectedValueError {
  return new RejectedValueError({
    digest: tombstone.digest,
    tenantId: tombstone.tenantId,
    entryId,
    reason: tombstone.reason,
    rejectedAt: tombstone.rejectedAt,
  });
}
