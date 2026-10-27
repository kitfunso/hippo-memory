// Sleep's tombstone lookups and refusal audit rows, each one call on the store; a dry run reads and
// writes neither.
import type { StoreWith } from '../../base/ports/store.js';
import type { RejectedValueRow } from '../../base/ports/store/rejections.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';
import { contentDigests } from '../../base/records/rejection-digest.js';

export interface TombstoneChecks {
  /** The tenant's tombstone for any form of `text`, the stored form's first; null when there is
   * none, and always under dryRun. */
  find(tenantId: string, text: string): Promise<RejectedValueRow | null>;
  /** The texts among `texts` the tenant holds a tombstone for in any form, in one store call; none
   * under dryRun, as `find`. */
  rejectedAmong(tenantId: string, texts: readonly string[]): Promise<Set<string>>;
  /** One audit row; nothing under dryRun. */
  audit(event: AppendAuditOptions): Promise<void>;
  /** `audit`, with a failed write logged and counted instead of thrown, for a refusal that
   * stands without its row. */
  auditOrCount(event: AppendAuditOptions): Promise<void>;
}

/** The checks of one sleep on `store`; under dryRun no call reaches the store. */
export function tombstoneChecks(
  store: StoreWith<'consolidation'>,
  dryRun: boolean,
): TombstoneChecks {
  const audit = async (event: AppendAuditOptions): Promise<void> => {
    if (!dryRun) await store.appendAuditEvents([event]);
  };
  return {
    async find(tenantId, text) {
      if (dryRun) return null;
      const digests = contentDigests(text);
      const rows = new Map(
        (await store.consolidation.rejected(tenantId, digests)).map((row) => [row.digest, row]),
      );
      return digests.map((d) => rows.get(d)).find((row) => row !== undefined) ?? null;
    },
    async rejectedAmong(tenantId, texts) {
      if (dryRun || texts.length === 0) return new Set();
      const forms = texts.map((text) => contentDigests(text));
      const held = new Set(
        (await store.consolidation.rejected(tenantId, forms.flat())).map((row) => row.digest),
      );
      return new Set(texts.filter((_, i) => forms[i]!.some((d) => held.has(d))));
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
