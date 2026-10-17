// hippo.db's half of the Rejections store group: each call on a handle of its own.
import { RejectedValueError } from '../../core/api-errors.js';
import { onHandle, openStore } from '../open.js';
import type { Rejections } from '../port/rejections.js';
import type { Sync } from '../port.js';
import { applyRejectionAt, liftRejectionAt } from '../rejected-values.js';
import { checkRejectionGuard, listRejectedValues } from '../rejection.js';

export function sqliteRejections(hippoRoot: string): Sync<Rejections> {
  return {
    apply: (rejection) => onHandle(hippoRoot, (db) => applyRejectionAt(db, hippoRoot, rejection), openStore),
    lift: (tenantId, digestPrefix, actor) =>
      onHandle(hippoRoot, (db) => liftRejectionAt(db, tenantId, digestPrefix, actor), openStore),
    list: (tenantId) => onHandle(hippoRoot, (db) => listRejectedValues(db, tenantId), openStore),
    refusedAmong: (checks) =>
      onHandle(hippoRoot, (db) =>
        checks.map(({ tenantId, entryId, content }) => {
          try {
            checkRejectionGuard(db, tenantId, entryId, content);
            return false;
          } catch (err) {
            if (err instanceof RejectedValueError) return true;
            throw err;
          }
        }),
      ),
  };
}
