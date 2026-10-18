// hippo.db's half of the Rejections store group: each call on a handle of its own.
import { RejectedValueError } from '../../core/api-errors.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';
import type { Rejections } from '../port/rejections.js';
import type { Sync } from '../port.js';
import { applyRejectionAt, liftRejectionAt } from '../rejected-values.js';
import { checkRejectionGuard, listRejectedValues } from './rejection.js';

export function sqliteRejections(on: OnHandle): Sync<Rejections> {
  return {
    apply: (rejection) => on((db, files) => applyRejectionAt(db, files, rejection), openStore),
    lift: (tenantId, digestPrefix, actor) => on((db) => liftRejectionAt(db, tenantId, digestPrefix, actor), openStore),
    list: (tenantId) => on((db) => listRejectedValues(db, tenantId), openStore),
    refusedAmong: (checks) =>
      on((db) =>
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
