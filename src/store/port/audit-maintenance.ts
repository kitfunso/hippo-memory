import type { AuditPrune } from '../audit.js';
import type { QualityRepairResult } from '../quality-repair.js';

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
  /** Counts (dryRun) or deletes the tenant's audit rows before
   * `cutoff`, then appends one audit_prune row; resolves to the count. */
  pruneAuditRows(prune: AuditPrune): Promise<number>;
  /** A preview, or with `apply` the moves of certain defects to dormant storage behind a backup. */
  repairQuality(tenantId: string, apply: boolean): Promise<QualityRepairResult>;
  /** repairQuality applied once per store; null once it ran there. */
  repairQualityOnce(tenantId: string): Promise<QualityRepairResult | null>;
}
