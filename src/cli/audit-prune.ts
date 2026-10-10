/** Audit log retention pruning: opt-in per tenant because retention floors (HIPAA, SOX, GDPR) apply.
 * The audit_prune row is written after the DELETE, so a call never prunes its own record. */

import { pruneAuditRows } from '../store/audit.js';
import { DAY_MS } from '../util/time.js';

export interface PruneAuditOpts {
  /** Cutoff in days. Rows with `ts < (now - N days)` are deleted. */
  olderThanDays: number;
  /** Tenant scope. Required: prune is always tenant-scoped. */
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

/** Cutoff ISO timestamp for N days ago; exported so tests can pin "now" without mocking Date. */
export function computeCutoff(days: number, now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  return cutoff.toISOString();
}

function isTenantIdString(value: string): value is string {
  return typeof value === 'string';
}

/** Delete audit_log rows older than `olderThanDays` for `tenantId`, emitting an `audit_prune` event.
 * Throws on non-positive days or a missing tenantId. */
export function pruneAuditLog(
  hippoRoot: string,
  opts: PruneAuditOpts,
): PruneAuditResult {
  if (!Number.isFinite(opts.olderThanDays) || opts.olderThanDays <= 0) {
    throw new Error(`pruneAuditLog: olderThanDays must be a positive number, got ${opts.olderThanDays}`);
  }
  if (!opts.tenantId || !isTenantIdString(opts.tenantId)) {
    throw new Error('pruneAuditLog: tenantId is required');
  }
  const dryRun = opts.dryRun === true;
  const actor = opts.actor ?? 'cli';
  const cutoff = computeCutoff(opts.olderThanDays);

  const count = pruneAuditRows(hippoRoot, { tenantId: opts.tenantId, cutoff, actor, olderThanDays: opts.olderThanDays, dryRun });
  return { cutoff, count, dryRun };
}

/** Parse `--older-than`: bare integer days (`30`) or with a `d` suffix (`30d`); throws on any other format. */
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
