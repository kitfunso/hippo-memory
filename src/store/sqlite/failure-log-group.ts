// hippo.db's half of the FailureLog store group: each call on a handle of its own.
import type { OnHandle } from '../open.js';
import type { FailureLog } from '../port/failure-log.js';
import type { Sync } from '../port.js';
import { recordFailure, requestOutcome, settleFailureOutcome } from '../failure-log.js';

export function sqliteFailureLog(on: OnHandle): Sync<FailureLog> {
  return {
    record: (event) => on((db) => recordFailure(db, event)),
    requestOutcome: (tenantId, requestId, sessionId) => on((db) => requestOutcome(db, tenantId, requestId, sessionId)),
    settleOutcome: (tenantId, requestId, outcome) =>
      on((db) => settleFailureOutcome(db, tenantId, requestId, outcome)),
  };
}
