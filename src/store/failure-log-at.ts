// The failure log on a handle of its own, for code that has a folder and no connection.
import { onHandle } from './open.js';
import { recordFailure, requestOutcome, settleFailureOutcome, type FailureEvent, type FailureOutcome } from './failure-log.js';

/** {@link recordFailure} on a handle of its own. */
export function recordFailureAt(hippoRoot: string, event: FailureEvent): void {
  onHandle(hippoRoot, (db) => recordFailure(db, event));
}

/** {@link requestOutcome} on a handle of its own. */
export function requestOutcomeAt(hippoRoot: string, tenantId: string, requestId: string, sessionId: string): FailureOutcome | null {
  return onHandle(hippoRoot, (db) => requestOutcome(db, tenantId, requestId, sessionId));
}

/** {@link settleFailureOutcome} on a handle of its own. */
export function settleFailureOutcomeAt(hippoRoot: string, tenantId: string, requestId: string, outcome: FailureOutcome): void {
  onHandle(hippoRoot, (db) => settleFailureOutcome(db, tenantId, requestId, outcome));
}
