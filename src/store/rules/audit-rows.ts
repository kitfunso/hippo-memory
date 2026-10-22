// Audit rows both adapters write with the same op and keys: a summary flipping dirty, and a value the rejected-value
// guard refused.
import type { AppendAuditOpts } from '../port/types.js';

/** The row for a summary whose dirty flag flipped from clean to dirty. */
export function summaryDirtyAudit(
  summaryId: string,
  tenantId: string,
  actor: string,
  dagLevel: number,
): AppendAuditOpts {
  const metadata = { dag_level: dagLevel, source: 'E2' };
  return { tenantId, actor, op: 'summary_marked_dirty', targetId: summaryId, metadata };
}

/** The row a refused write of `targetId` leaves; `tombstone` is the rejected value it matched. */
export function refusalAudit(
  tenantId: string,
  actor: string,
  targetId: string,
  tombstone: { readonly digest: string; readonly reason: string | null },
) {
  const metadata = { digest: tombstone.digest, reason: tombstone.reason };
  return { tenantId, actor, op: 'reject_refusal' as const, targetId, metadata };
}
