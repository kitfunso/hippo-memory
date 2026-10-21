// The audit groups: the audit list, and the maintenance that prunes it, deletes automatically and repairs quality.
import type { AuditOp } from '../../base/records/audit-ops.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT } from '../../base/util/limits.js';
import type { AuditEvent } from './types.js';
import type { RepairProtection } from '../../base/memory/memory-audit.js';

/** The rows an audit list reads for `limit`: one past the cap, since GET /v1/audit reads a row ahead to tell whether
 * another page exists. */
export const auditRowsRead = (limit: number | undefined): number =>
  Math.max(1, Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT + 1));

/** The read behind the audit list. It writes no audit row. */
export interface AuditLog {
  /** One tenant's rows newest first, by ts then id descending, narrowed by `op` and by `since` (ts at or after it);
   * `limit` reads auditRowsRead rows, and `after` resumes below the (ts, id) position a page ended
   * on. */
  listAuditEvents(query: QueryAuditOptions): Promise<AuditEvent[]>;
}

export interface QueryAuditOptions {
  tenantId: string;
  op?: AuditOp;
  since?: string; // ISO timestamp
  limit?: number;
  /** Resume after this row: the (ts, id) position the previous page ended on. */
  after?: KeysetPosition;
}

export type { RepairProtection };

/** The reads and writes behind the memory-quality audit, its repair and audit-log retention. */
export interface AuditMaintenance {
  /** The ids among `ids` that a typed object row names, in any tenant; an automatic pass never deletes one. */
  objectBackedAmong(ids: readonly string[]): Promise<Set<string>>;
  /** Deletes each removal's row with its own forget row, leaving a pinned, raw, kept or object-backing row; resolves to
   * the ids deleted. */
  deleteAutomatically(
    removals: readonly { readonly id: string; readonly reason: string }[],
    actor: string,
  ): Promise<string[]>;
  /** Counts (dryRun) or deletes the tenant's audit rows before `cutoff`, then appends one audit_prune row; resolves to
   * the count. */
  pruneAuditRows(prune: AuditPrune): Promise<number>;
  /** A preview, or with `apply` the moves of certain defects to dormant storage behind a backup; a row
   * `repairKeeps(row, backsObject, protect)` names is kept, checked inside the repair's write. */
  repairQuality(tenantId: string, apply: boolean, protect: RepairProtection): Promise<QualityRepairResult>;
  /** repairQuality applied once per store; null once it ran there. */
  repairQualityOnce(tenantId: string, protect: RepairProtection): Promise<QualityRepairResult | null>;
}

export interface AuditPrune {
  tenantId: string;
  /** ISO time; rows with `ts` before it go. */
  cutoff: string;
  actor: string;
  olderThanDays: number;
  /** Count the rows and delete nothing. */
  dryRun: boolean;
}

/**
 * One tenant's plan; `supported` is false, with `blockers` naming each gap, when the schema cannot be changed safely.
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

/** One automatic row with a defect. `set-aside` moves to dormant storage on apply, `review` is listed only, `protected`
 * is kept. */
export interface QualityRepairIssue {
  readonly id: string;
  readonly reason: string;
  readonly disposition: 'set-aside' | 'review' | 'protected';
  readonly protection?: string;
}
