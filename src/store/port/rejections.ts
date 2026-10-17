// The Rejections group, kept apart from port.ts: the tombstones `hippo reject` writes and every write guard reads.
import type { AppliedRejection, LiftedRejection, Rejection } from '../rejected-values.js';

export interface RejectionCheck {
  readonly tenantId: string;
  readonly entryId: string;
  readonly content: string;
}

export interface Rejections {
  /** In one transaction: the tombstone, the removal of every row in reach holding the text, one reject_value row. */
  apply(rejection: Rejection): Promise<AppliedRejection>;
  /** Lifts the tenant's one tombstone `digestPrefix` names, with its unreject_value row; none or two write nothing. */
  lift(tenantId: string, digestPrefix: string, actor: string): Promise<LiftedRejection>;
  list(tenantId: string): Promise<RejectedValueRow[]>;
  /** Whether a write guard would refuse each check, in order; writes nothing, so a dry run counts what a run skips. */
  refusedAmong(checks: readonly RejectionCheck[]): Promise<boolean[]>;
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
