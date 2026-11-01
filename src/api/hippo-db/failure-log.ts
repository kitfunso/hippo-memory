// Tool failures on hippo.db's local tier: each failure's log row and the lessons a repeat check
// reads. A remote caller's request id allows one row, so a retried send gets the first answer.
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { FailureEvent, FailureOutcome } from '../../base/records/rejections.js';
import type { HippoDbContext } from '../hippo-db-context.js';

/** Where a failure is logged: a store with the local tier and the tenant its rows go under. */
type FailureFolder = Pick<HippoDbContext, 'store' | 'tenantId'>;

/** The failure's log row, in the folder's tenant; its id. */
export function logFailure(
  { store, tenantId }: FailureFolder,
  event: Omit<FailureEvent, 'tenantId'>,
): Promise<number> {
  return store.hippoDb.failureLog.record({ ...event, tenantId });
}

/** The tenant's auto-captured lessons, under `origins` when a caller's project narrows them, for
 * the repeat check before a new one is kept. */
export function heldLessons(
  { store, tenantId }: FailureFolder,
  origins?: readonly string[],
): Promise<string[]> {
  return store.hippoDb.lessonWrites.contentsWithTag(tenantId, 'auto-captured', origins);
}

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
