// The in-memory FailureLog group, and the failure totals the Reports group reads from the same rows.
import { ConflictError } from '../../base/errors/api-errors.js';
import type { FailureEvent, FailureLog, FailureSummary } from '../port/rejections.js';
import { failureRow, failureTotals, RATED_OUTCOMES, retentionCutoff, sameStoredSession } from '../rules/failure-log.js';
import { byBytes } from '../rules/order.js';
import { nextId } from './rows.js';
import type { LoggedFailure, MemoryTables } from './tables.js';

const byRequest = (t: MemoryTables, tenantId: string, requestId: string): LoggedFailure | undefined =>
  t.failures.find((r) => r.tenantId === tenantId && r.requestId === requestId);

/** Prunes rows past the retention window, then appends one; the prune stays when the append is refused. */
function recordIn(t: MemoryTables, event: FailureEvent): number {
  const row = failureRow(event);
  const cutoff = retentionCutoff(row.ts);
  t.failures = t.failures.filter((r) => byBytes(r.ts, cutoff) >= 0);
  if (row.requestId !== null && byRequest(t, row.tenantId, row.requestId)) {
    throw new Error('UNIQUE constraint failed: failure_log.tenant_id, failure_log.request_id');
  }
  const id = nextId(t, 'failure_log');
  t.failures.push({ id, ...row });
  return id;
}

function requestOutcomeIn(t: MemoryTables, tenantId: string, requestId: string, sessionId: string) {
  const row = byRequest(t, tenantId, requestId);
  if (row === undefined) return null;
  if (!sameStoredSession(row.sessionId, sessionId)) {
    throw new ConflictError('request id belongs to another session');
  }
  return row.outcome;
}

export function memoryFailureLog(t: MemoryTables): FailureLog {
  return {
    record: async (event) => recordIn(t, event),
    requestOutcome: async (tenantId, requestId, sessionId) => requestOutcomeIn(t, tenantId, requestId, sessionId),
    settleOutcome: async (tenantId, requestId, outcome) => {
      const row = byRequest(t, tenantId, requestId);
      if (row) row.outcome = outcome;
    },
  };
}

/** The tenant's failure totals since `sinceIso`. */
export function failureSummary(t: MemoryTables, tenantId: string, sinceIso: string): FailureSummary {
  const mine = t.failures.filter((r) => r.tenantId === tenantId);
  const inWindow = mine.filter((r) => byBytes(r.ts, sinceIso) >= 0);
  const rated = [...mine]
    .sort((a, b) => a.id - b.id)
    .flatMap((r) =>
      r.sessionId !== null && r.sigHash !== null && RATED_OUTCOMES.includes(r.outcome)
        ? [{ ts: r.ts, sessionId: r.sessionId, sigHash: r.sigHash }]
        : [],
    );
  return failureTotals(sinceIso, (outcome) => inWindow.filter((r) => r.outcome === outcome).length, rated);
}
