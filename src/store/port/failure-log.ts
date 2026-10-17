// The FailureLog group, kept apart from port.ts: the row each tool failure writes, read back by request id so a retried
// send gets the first answer.
import type { FailureEvent, FailureOutcome } from '../failure-log.js';

export interface FailureLog {
  /** Appends one row and answers its id. */
  record(event: FailureEvent): Promise<number>;
  /** The outcome logged under the request id, or null; an id another session logged rejects with ConflictError. */
  requestOutcome(tenantId: string, requestId: string, sessionId: string): Promise<FailureOutcome | null>;
  settleOutcome(tenantId: string, requestId: string, outcome: FailureOutcome): Promise<void>;
}
