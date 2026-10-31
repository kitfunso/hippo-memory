// A rejected-value check for a dry run, on a handle the caller never sees.
import { onHandle } from './open.js';
import { checkRejectionGuard } from './rejection.js';
import { RejectedValueError } from '../core/api-errors.js';

export type RejectionProbe = (tenantId: string, entryId: string, content: string) => boolean;

/** Runs `fn` with a probe that says whether the write guard would refuse the content; the handle closes after. */
export function withRejectionProbe<T>(hippoRoot: string, fn: (wouldReject: RejectionProbe) => T): T {
  return onHandle(hippoRoot, (db) =>
    fn((tenantId, entryId, content) => {
      try {
        checkRejectionGuard(db, tenantId, entryId, content);
        return false;
      } catch (err) {
        if (err instanceof RejectedValueError) return true;
        throw err;
      }
    }),
  );
}
