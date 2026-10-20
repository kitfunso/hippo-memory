import type { RepairProtection } from '../../base/memory/memory-audit.js';

export type { RepairProtection };

/** The reads and writes behind the memory-quality audit, its repair and audit-log retention. */
export interface AuditMaintenance {
  /** The ids of every memory a typed object row names, in any tenant; an automatic pass never deletes one. */
  objectBackedIds(): Promise<Set<string>>;
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
