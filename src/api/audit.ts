// Audit log queries and retention, and the memory-quality audit with its repair passes.

import { auditMemories, pruneAuditRows, type AuditEvent, type AuditIssue, type AuditOp, type AuditResult } from '../store/audit.js';
import { deleteEntry, memoriesBackingObjects } from '../store/delete-and-batch.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { repairAutomaticMemories, repairQualityOnce, type QualityRepairResult } from '../store/quality-repair.js';
import { DAY_MS } from '../util/time.js';
import { requireGroup, storeFor } from '../store/index.js';
import type { KeysetPosition } from '../util/keyset.js';
import type { Context } from './types.js';

export interface AuditListOpts {
  op?: AuditOp;
  /** ISO timestamp lower bound. */
  since?: string;
  limit?: number;
  /** Resume after this row: the (ts, id) position the previous page ended on. */
  after?: KeysetPosition;
}

/** Read audit events scoped to `ctx.tenantId` on the store the request runs on. Read-only, no audit emit. */
export async function auditList(ctx: Context, opts: AuditListOpts): Promise<AuditEvent[]> {
  return requireGroup(storeFor(ctx), 'auditLog').listAuditEvents({
    tenantId: ctx.tenantId, op: opts.op, since: opts.since, limit: opts.limit, after: opts.after,
  });
}

/** The pass that removes audit errors; it leads the reason on each forget row. */
export type AuditPass = 'audit --fix' | 'sleep-audit';

/** Delete the memories an audit marked as errors, each with its own forget row, and answer the ids that went: a pinned or raw row stays. */
export function removeAuditErrors(ctx: Context, pass: AuditPass, issues: readonly AuditIssue[]): string[] {
  return issues
    .filter((issue) => issue.severity === 'error')
    .filter((issue) => deleteEntry(ctx.hippoRoot, issue.memoryId, { actor: ctx.actor.subject, reason: `${pass}: ${issue.reason}`, automatic: true }))
    .map((issue) => issue.memoryId);
}

/** The caller's memories run through the quality audit; a memory that backs an object is never marked for removal. */
export function auditMemoryQuality(ctx: Context): AuditResult {
  return auditMemories(loadAllEntries(ctx.hippoRoot, ctx.tenantId), memoriesBackingObjects(ctx.hippoRoot));
}

/** Audit repair for the caller's tenant: a preview, or with `apply` the moves of certain defects to dormant storage behind a backup. */
export function repairMemoryQuality(ctx: Context, apply: boolean): QualityRepairResult {
  return repairAutomaticMemories(ctx.hippoRoot, { tenantId: ctx.tenantId, apply });
}

/** The repair sleep and the daily runner apply once per store after an upgrade; null when it already ran there. */
export function repairMemoryQualityOnce(ctx: Context): QualityRepairResult | null {
  return repairQualityOnce(ctx.hippoRoot, ctx.tenantId);
}

export interface PruneAuditOpts {
  /** Cutoff in days. Rows with `ts < (now - N days)` are deleted. */
  olderThanDays: number;
  /** When true, count matching rows but do NOT delete. Default false. */
  dryRun?: boolean;
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

/** Delete the caller's tenant's audit_log rows older than `olderThanDays`, then record an `audit_prune` row as `ctx.actor`; opt-in, since
 *  retention floors (HIPAA, SOX, GDPR) apply. The row is written after the DELETE, so a call never prunes its own record.
 *  Throws on non-positive days or an empty tenant. */
export function pruneAuditLog(ctx: Context, opts: PruneAuditOpts): PruneAuditResult {
  if (!Number.isFinite(opts.olderThanDays) || opts.olderThanDays <= 0) {
    throw new Error(`pruneAuditLog: olderThanDays must be a positive number, got ${opts.olderThanDays}`);
  }
  if (!ctx.tenantId) {
    throw new Error('pruneAuditLog: tenantId is required');
  }
  const dryRun = opts.dryRun === true;
  const cutoff = computeCutoff(opts.olderThanDays);
  const count = pruneAuditRows(ctx.hippoRoot, { tenantId: ctx.tenantId, cutoff, actor: ctx.actor.subject, olderThanDays: opts.olderThanDays, dryRun });
  return { cutoff, count, dryRun };
}
