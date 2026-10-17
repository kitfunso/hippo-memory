// hippo.db's half of the FailureLog store group: each call on a handle of its own.
import { onHandle } from '../open.js';
import type { FailureLog } from '../port/failure-log.js';
import type { Sync } from '../port.js';
import { recordFailure, requestOutcome, settleFailureOutcome } from '../failure-log.js';

export function sqliteFailureLog(hippoRoot: string): Sync<FailureLog> {
  return {
    record: (event) => onHandle(hippoRoot, (db) => recordFailure(db, event)),
    requestOutcome: (tenantId, requestId, sessionId) =>
      onHandle(hippoRoot, (db) => requestOutcome(db, tenantId, requestId, sessionId)),
    settleOutcome: (tenantId, requestId, outcome) =>
      onHandle(hippoRoot, (db) => settleFailureOutcome(db, tenantId, requestId, outcome)),
  };
}
