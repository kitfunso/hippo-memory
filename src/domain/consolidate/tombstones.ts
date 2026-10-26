// Sleep's tombstone lookups and refusal audit rows, each one call on the store; a dry run reads and writes neither.
import type { StoreWith } from '../../base/ports/store.js';
import type { RejectedValueRow } from '../../base/ports/store/rejections.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';

export interface TombstoneChecks {
  /** The tenant's tombstone for `digest`; null when there is none, and always under dryRun. */
  find(tenantId: string, digest: string): Promise<RejectedValueRow | null>;
  /** The digests among `digests` the tenant holds a tombstone for, in one store call; none under dryRun, as `find`. */
  rejectedAmong(tenantId: string, digests: readonly string[]): Promise<Set<string>>;
  /** One audit row; nothing under dryRun. */
  audit(event: AppendAuditOptions): Promise<void>;
  /** `audit`, with a failed write logged and counted instead of thrown, for a refusal that stands without its row. */
  auditOrCount(event: AppendAuditOptions): Promise<void>;
}

/** The checks of one sleep on `store`; under dryRun no call reaches the store. */
export function tombstoneChecks(store: StoreWith<'consolidation'>, dryRun: boolean): TombstoneChecks {
  const audit = async (event: AppendAuditOptions): Promise<void> => {
    if (!dryRun) await store.appendAuditEvents([event]);
  };
  return {
    find: async (tenantId, digest) =>
      dryRun ? null : ((await store.consolidation.rejected(tenantId, [digest]))[0] ?? null),
    async rejectedAmong(tenantId, digests) {
      if (dryRun || digests.length === 0) return new Set();
      return new Set((await store.consolidation.rejected(tenantId, digests)).map((row) => row.digest));
    },
    audit,
    async auditOrCount(event) {
      try {
        await audit(event);
      } catch (error) {
        reportAuditWriteFailure(event.op, error, event.targetId);
      }
    },
  };
}
