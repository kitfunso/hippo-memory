// Audit log queries and retention, and the memory-quality audit with its repair passes.

import type { AuditEvent, AuditOp } from '../../store/audit.js';
import { auditMemories, type AuditIssue, type AuditResult } from '../../core/memory-audit.js';
import type { QualityRepairResult } from '../../store/quality-repair.js';
import type { AuditMaintenance } from '../../store/port.js';
import { DAY_MS } from '../../util/time.js';
import type { KeysetPosition } from '../../util/keyset.js';
import type { ContextWith } from '../types.js';

export interface AuditListOpts {
  op?: AuditOp;
  /** ISO timestamp lower bound. */
  since?: string;
  limit?: number;
  /** Resume after this row: the (ts, id) position the previous page ended on. */
  after?: KeysetPosition;
}

/** Read audit events scoped to `ctx.tenantId` on the store the request runs on. Read-only, no audit emit. */
export async function auditList(ctx: ContextWith<'auditLog'>, opts: AuditListOpts): Promise<AuditEvent[]> {
  return ctx.store.auditLog.listAuditEvents({
    tenantId: ctx.tenantId, op: opts.op, since: opts.since, limit: opts.limit, after: opts.after,
  });
}

/** The pass that removes audit errors; it leads the reason on each forget row. */
export type AuditPass = 'audit --fix' | 'sleep-audit';

function maintenanceOf(ctx: ContextWith<'auditMaintenance'>): AuditMaintenance {
  return ctx.store.auditMaintenance;
}

/** Delete the memories an audit marked as errors, each with its own forget row, and answer the ids that went: a pinned
 * or raw row stays. */
export async function removeAuditErrors(
  ctx: ContextWith<'auditMaintenance'>,
  pass: AuditPass,
  issues: readonly AuditIssue[],
): Promise<string[]> {
  const removals = issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => ({ id: issue.memoryId, reason: `${pass}: ${issue.reason}` }));
  if (removals.length === 0) return [];
  return maintenanceOf(ctx).deleteAutomatically(removals, ctx.actor.subject);
}

/** The caller's memories run through the quality audit; a memory that backs an object is never marked for removal. */
export async function auditMemoryQuality(ctx: ContextWith<'auditMaintenance'>): Promise<AuditResult> {
  const maintenance = maintenanceOf(ctx);
  return auditMemories(await maintenance.tenantEntries(ctx.tenantId), await maintenance.objectBackedIds());
}

/** Audit repair for the caller's tenant: a preview, or with `apply` the moves of certain defects to dormant storage
 * behind a backup. */
export async function repairMemoryQuality(
  ctx: ContextWith<'auditMaintenance'>,
  apply: boolean,
): Promise<QualityRepairResult> {
  return maintenanceOf(ctx).repairQuality(ctx.tenantId, apply);
}

/** The repair sleep and the daily runner apply once per store after an upgrade; null when it already ran there. */
export async function repairMemoryQualityOnce(
  ctx: ContextWith<'auditMaintenance'>,
): Promise<QualityRepairResult | null> {
  return maintenanceOf(ctx).repairQualityOnce(ctx.tenantId);
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

/** Delete the caller's tenant's audit_log rows older than `olderThanDays`, then record an `audit_prune` row as
 * `ctx.actor`; opt-in, since retention floors (HIPAA, SOX, GDPR) apply. The row is written after the DELETE, so a call
 * never prunes its own record. Throws on non-positive days or an empty tenant. */
export async function pruneAuditLog(
  ctx: ContextWith<'auditMaintenance'>,
  opts: PruneAuditOpts,
): Promise<PruneAuditResult> {
  if (!Number.isFinite(opts.olderThanDays) || opts.olderThanDays <= 0) {
    throw new Error(`pruneAuditLog: olderThanDays must be a positive number, got ${opts.olderThanDays}`);
  }
  if (!ctx.tenantId) {
    throw new Error('pruneAuditLog: tenantId is required');
  }
  const dryRun = opts.dryRun === true;
  const cutoff = computeCutoff(opts.olderThanDays);
  const prune = { tenantId: ctx.tenantId, cutoff, actor: ctx.actor.subject, olderThanDays: opts.olderThanDays, dryRun };
  const count = await maintenanceOf(ctx).pruneAuditRows(prune);
  return { cutoff, count, dryRun };
}
