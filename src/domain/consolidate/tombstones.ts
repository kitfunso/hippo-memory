// Sleep's tombstone lookups and refusal audit rows, each one call on the store; a dry run reads the
// tombstones as a real run does, so it refuses what the real run refuses, and writes no row.
import type { StoreWith } from '../../base/ports/store.js';
import type { RejectedValueRow } from '../../base/ports/store/rejections.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';

export interface TombstoneChecks {
  /** The tenant's tombstone for `digest`; null when there is none. */
  find(tenantId: string, digest: string): Promise<RejectedValueRow | null>;
  /** The digests among `digests` the tenant holds a tombstone for, in one store call. */
  rejectedAmong(tenantId: string, digests: readonly string[]): Promise<Set<string>>;
  /** One audit row; nothing under dryRun. */
  audit(event: AppendAuditOptions): Promise<void>;
  /** `audit`, with a failed write logged and counted instead of thrown, for a refusal that
   * stands without its row. */
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
