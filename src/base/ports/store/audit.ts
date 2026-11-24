import type { AuditOp } from '../../records/audit-ops.js';
import type { KeysetPosition } from '../../util/keyset.js';
import { DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT } from '../../util/limits.js';
import type { AuditEvent } from './types.js';
import type { RepairProtection } from '../../memory/memory-audit.js';
import type { MethodEffects } from './effects.js';

/** The rows an audit list reads for `limit`: one past the cap, since GET /v1/audit reads a row
 * ahead to tell whether another page exists. */
export const auditRowsRead = (limit: number | undefined): number =>
  Math.max(1, Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT + 1));

/** The read behind the audit list. It writes no audit row. */
export interface AuditLog {
  listAuditEvents(query: QueryAuditOptions): Promise<AuditEvent[]>;
}

/** What each AuditLog method does to the store; every adapter honours it. */
export const AUDIT_LOG_EFFECTS = {
  listAuditEvents: 'read',
} as const satisfies MethodEffects<AuditLog>;

export interface QueryAuditOptions {
  tenantId: string;
  op?: AuditOp;
  since?: string;
  limit?: number;
  after?: KeysetPosition;
}

export type { RepairProtection };

/** The reads and writes behind the memory-quality audit, its repair and audit-log retention. */
export interface AuditMaintenance {
  objectBackedAmong(ids: readonly string[]): Promise<Set<string>>;
  deleteAutomatically(
    removals: readonly { readonly id: string; readonly reason: string }[],
    actor: string,
  ): Promise<string[]>;
  pruneAuditRows(prune: AuditPrune): Promise<number>;
  repairQuality(
    tenantId: string,
    apply: boolean,
    protect: RepairProtection,
  ): Promise<QualityRepairResult>;
  repairQualityOnce(
    tenantId: string,
    protect: RepairProtection,
  ): Promise<QualityRepairResult | null>;
}

/** What each AuditMaintenance method does to the store; every adapter honours it. */
export const AUDIT_MAINTENANCE_EFFECTS = {
  objectBackedAmong: 'read',
  deleteAutomatically: 'write',
  pruneAuditRows: 'write',
  repairQuality: 'write',
  repairQualityOnce: 'write',
} as const satisfies MethodEffects<AuditMaintenance>;

export interface AuditPrune {
  tenantId: string;
  cutoff: string;
  actor: string;
  olderThanDays: number;
  dryRun: boolean;
}

/**
 * One tenant's plan; `supported` is false, with `blockers` naming each gap, when the schema cannot
 * be changed safely.
 */
export interface QualityRepairResult {
  readonly root: string;
  readonly schema: number;
  readonly supported: boolean;
  readonly blockers: readonly string[];
  readonly total: number;
  readonly issues: readonly QualityRepairIssue[];
  readonly appliedIds: readonly string[];
  readonly backup: string | null;
  readonly warnings: readonly string[];
}

/** One automatic row with a defect. `set-aside` moves to dormant storage on apply, `review` is
 * listed only, `protected` is kept. */
export interface QualityRepairIssue {
  readonly id: string;
  readonly reason: string;
  readonly disposition: 'set-aside' | 'review' | 'protected';
  readonly protection?: string;
}
