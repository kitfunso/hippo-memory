// Sleep's tombstone lookups and refusal audit rows, each one call on the store; a dry run reads and writes neither.
import type { StoreWith } from '../../store/port.js';
import type { RejectedValueRow } from '../../store/port/rejections.js';
import type { AppendAuditOpts } from '../../store/port/types.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';
import { errorMessage } from '../../base/util/log.js';

export interface TombstoneChecks {
  /** The tenant's tombstone for `digest`; null when there is none, and always under dryRun. */
  find(tenantId: string, digest: string): Promise<RejectedValueRow | null>;
  /** The digests among `digests` the tenant holds a tombstone for, in one store call; none under dryRun, as `find`. */
  rejectedAmong(tenantId: string, digests: readonly string[]): Promise<Set<string>>;
  /** One audit row; nothing under dryRun. */
  audit(event: AppendAuditOpts): Promise<void>;
  /** `audit`, with a failed write logged and counted instead of thrown, for a refusal that stands without its row. */
  auditOrCount(event: AppendAuditOpts): Promise<void>;
}

/** The checks of one sleep on `store`; under dryRun no call reaches the store. */
export function tombstoneChecks(store: StoreWith<'consolidation'>, dryRun: boolean): TombstoneChecks {
  const audit = async (event: AppendAuditOpts): Promise<void> => {
    if (!dryRun) await store.appendAuditEvents([event]);
  };
  return {
    find: async (tenantId, digest) => (dryRun ? null : store.consolidation.rejectedValue(tenantId, digest)),
    rejectedAmong: async (tenantId, digests) =>
      dryRun || digests.length === 0 ? new Set() : store.consolidation.rejectedDigests(tenantId, digests),
    audit,
    async auditOrCount(event) {
      try {
        await audit(event);
      } catch (error) {
        reportAuditWriteFailure(event.op, errorMessage(error), event.targetId);
      }
    },
  };
}
