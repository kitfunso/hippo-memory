import type { StoreWith } from '../../base/ports/store.js';
import type { RejectedValueRow } from '../../base/ports/store/rejections.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';

export interface TombstoneChecks {
  find(tenantId: string, digest: string): Promise<RejectedValueRow | null>;
  rejectedAmong(tenantId: string, digests: readonly string[]): Promise<Set<string>>;
  audit(event: AppendAuditOptions): Promise<void>;
  auditOrCount(event: AppendAuditOptions): Promise<void>;
}

/** The checks of one sleep on `store`; under dryRun the lookups read and no audit row is written. */
export function tombstoneChecks(
  store: StoreWith<'consolidation'>,
  dryRun: boolean,
): TombstoneChecks {
  const audit = async (event: AppendAuditOptions): Promise<void> => {
    if (!dryRun) await store.appendAuditEvents([event]);
  };
  return {
    find: async (tenantId, digest) =>
      (await store.consolidation.rejected(tenantId, [digest]))[0] ?? null,
    async rejectedAmong(tenantId, digests) {
      if (digests.length === 0) return new Set();
      return new Set(
        (await store.consolidation.rejected(tenantId, digests)).map((row) => row.digest),
      );
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
