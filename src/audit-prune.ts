/**
 * Audit log retention pruning (v1.12.9).
 *
 * The `audit_log` table grows unbounded by default — every recall, write,
 * outcome, sleep, supersede, promote, forget, archive_raw, auth_revoke,
 * and auth_create emits a row. On a long-running deployment, this can
 * accumulate to millions of rows and slow down both audit queries and
 * incremental SQLite VACUUMs.
 *
 * Closes TODOS A5 v2 M6: "Audit log unbounded growth. Add a daily `audit
 * prune` cron + `hippo audit prune --older-than 90d` CLI in v2. Mind
 * regulatory retention floors (HIPAA, SOX, GDPR) — the prune should be
 * opt-in per tenant and emit its own audit trail event."
 *
 * Design notes:
 *   - Per-tenant by default (matches existing audit CLI conventions).
 *   - The prune itself emits an `audit_prune` audit row with metadata
 *     `{cutoff, count, dryRun}`, recursively recording the maintenance op
 *     in the audit trail. Operators investigating "where did old rows go"
 *     have one row left to find regardless of retention floor.
 *   - Dry-run mode returns the count without deleting — first-time
 *     operator safety.
 *   - DELETE is wrapped in a transaction so a mid-operation crash leaves
 *     audit_log in a consistent state.
 *   - The audit_prune row itself is NEVER pruned by the same call (it's
 *     written AFTER the DELETE WHERE ts < cutoff, so ts > cutoff).
 */

import type { DatabaseSyncLike } from './db.js';
import { appendAuditEvent } from './audit.js';

export interface PruneAuditOpts {
  /** Cutoff in days. Rows with `ts < (now - N days)` are deleted. */
  olderThanDays: number;
  /** Tenant scope. Required — prune is always tenant-scoped per the A5 v2 design. */
  tenantId: string;
  /** When true, count matching rows but do NOT delete. Default false. */
  dryRun?: boolean;
  /** Actor recording the prune in the audit trail. Default 'cli'. */
  actor?: string;
}

export interface PruneAuditResult {
  /** ISO timestamp of the cutoff. Rows with ts strictly less than this were deleted. */
  cutoff: string;
  /** Number of audit_log rows deleted (or that would be deleted, if dryRun). */
  count: number;
  /** Echo back whether this was a dry run. */
  dryRun: boolean;
}

/**
 * Compute the cutoff ISO timestamp for an N-days-ago cutoff. Exported for
 * testability so tests can pin "now" without mocking Date.
 */
export function computeCutoff(days: number, now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}

/**
 * Delete audit_log rows older than `olderThanDays` days for `tenantId`.
 * Emits an `audit_prune` event with metadata `{cutoff, count, dryRun}`.
 *
 * Throws on invalid inputs (non-positive days, missing tenantId).
 */
export function pruneAuditLog(
  db: DatabaseSyncLike,
  opts: PruneAuditOpts,
): PruneAuditResult {
  if (!Number.isFinite(opts.olderThanDays) || opts.olderThanDays <= 0) {
    throw new Error(`pruneAuditLog: olderThanDays must be a positive number, got ${opts.olderThanDays}`);
  }
  if (!opts.tenantId || typeof opts.tenantId !== 'string') {
    throw new Error('pruneAuditLog: tenantId is required');
  }
  const dryRun = opts.dryRun === true;
  const actor = opts.actor ?? 'cli';
  const cutoff = computeCutoff(opts.olderThanDays);

  let count = 0;
  if (dryRun) {
    // Dry-run: just count, no DELETE.
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE tenant_id = ? AND ts < ?`)
      .get(opts.tenantId, cutoff) as { c: number | bigint };
    count = Number(row.c);
  } else {
    db.exec('BEGIN');
    try {
      const result = db
        .prepare(`DELETE FROM audit_log WHERE tenant_id = ? AND ts < ?`)
        .run(opts.tenantId, cutoff);
      count = Number(result.changes ?? 0);
      // Record the prune itself in the audit trail. This row has ts = now,
      // so it's not eligible for the cutoff that was just applied.
      appendAuditEvent(db, {
        tenantId: opts.tenantId,
        actor,
        op: 'audit_prune',
        metadata: { cutoff, count, dryRun: false, olderThanDays: opts.olderThanDays },
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return { cutoff, count, dryRun };
}

/**
 * Parse the `--older-than <value>` flag. Accepts either bare integer days
 * (`30`) or integer with `d` suffix (`30d`). Throws on invalid format.
 */
export function parseOlderThanFlag(raw: string): number {
  const m = raw.match(/^(\d+)(d)?$/i);
  if (!m) {
    throw new Error(
      `Invalid --older-than value: "${raw}". Expected integer days (e.g. "30") or with d suffix ("30d").`,
    );
  }
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid --older-than value: "${raw}". Must be a positive integer.`);
  }
  return n;
}
