// Audit rows several store files write with the same op and keys: a summary flipping dirty, and a
// value the rejected-value guard refused.
import type { AppendAuditOptions } from '../../base/ports/store/types.js';

/** A summary marked dirty, and who marked it. */
export interface SummaryDirtyOptions {
  readonly summaryId: string;
  readonly tenantId: string;
  readonly actor: string;
}

/** The row for a summary whose dirty flag flipped from clean to dirty. */
export function summaryDirtyAudit(
  { summaryId, tenantId, actor }: SummaryDirtyOptions,
  dagLevel: number,
): AppendAuditOptions {
  const metadata = { dag_level: dagLevel, source: 'E2' };
  return { tenantId, actor, op: 'summary_marked_dirty', targetId: summaryId, metadata };
}

/** The tenant, actor and row of a refused write. */
export interface RefusalAuditOptions {
  readonly tenantId: string;
  readonly actor: string;
  readonly targetId: string;
}

/** The row a refused write of `targetId` leaves; `tombstone` is the rejected value it matched. */
export function refusalAudit(
  { tenantId, actor, targetId }: RefusalAuditOptions,
  tombstone: { readonly digest: string; readonly reason: string | null },
) {
  const metadata = { digest: tombstone.digest, reason: tombstone.reason };
  return { tenantId, actor, op: 'reject_refusal' as const, targetId, metadata };
}
