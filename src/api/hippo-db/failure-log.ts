// A remote caller's tool failures: one log row per request id, so a retried send gets the first
// answer.
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { FailureEvent, FailureOutcome } from '../../base/records/rejections.js';
import type { HippoDbContext } from '../hippo-db-context.js';

export type CallerFailureEvent = Omit<FailureEvent, 'tenantId' | 'requestId'> & {
  readonly requestId: string;
};

/** An id another session logged rejects with ConflictError. */
export function firstFailureOutcome(
  ctx: HippoDbContext,
  requestId: string,
  sessionId: string,
): Promise<FailureOutcome | null> {
  return ctx.store.hippoDb.failureLog.requestOutcome(ctx.tenantId, requestId, sessionId);
}

/** Runs after the outcome and logs its own error as a warning, so a log failure never hides the
 * store's error or its outcome. */
export async function logCallerFailure(
  ctx: HippoDbContext,
  event: CallerFailureEvent,
  retried: boolean,
): Promise<void> {
  const { failureLog } = ctx.store.hippoDb;
  try {
    // The request id allows one row, so a retry rewrites the first try's outcome.
    if (retried) {
      await failureLog.settleOutcome(ctx.tenantId, event.requestId, event.outcome);
      return;
    }
    await failureLog.record({ ...event, tenantId: ctx.tenantId });
  } catch (err) {
    log.warn(`capture-error: failure not logged: ${errorMessage(err)}`, errorFields(err));
  }
}
