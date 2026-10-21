// The in-memory FailureLog group, and the failure totals the Reports group reads from the same rows.
import { ConflictError } from '../../base/errors/api-errors.js';
import { FAILURE_LOG_RETENTION_DAYS } from '../../base/records/failure-log-retention.js';
import { failuresPerSession } from '../../base/records/failure-repeats.js';
import { MAX_HOOK_FIELD_LEN } from '../../base/util/limits.js';
import { DAY_MS } from '../../base/util/time.js';
import type { FailureEvent, FailureLog, FailureOutcome, FailureSummary } from '../port/failure-log.js';
import { byBytes, nextId } from './rows.js';
import type { LoggedFailure, MemoryTables } from './tables.js';

const byRequest = (t: MemoryTables, tenantId: string, requestId: string): LoggedFailure | undefined =>
  t.failures.find((r) => r.tenantId === tenantId && r.requestId === requestId);

/** Prunes rows past the retention window, then appends one; the prune stays when the append is refused. */
function recordIn(t: MemoryTables, event: FailureEvent): number {
  const ts = new Date(event.now ?? Date.now()).toISOString();
  const cutoff = new Date(Date.parse(ts) - FAILURE_LOG_RETENTION_DAYS * DAY_MS).toISOString();
  t.failures = t.failures.filter((r) => byBytes(r.ts, cutoff) >= 0);
  const requestId = event.requestId ?? null;
  if (requestId !== null && byRequest(t, event.tenantId, requestId)) {
    throw new Error('UNIQUE constraint failed: failure_log.tenant_id, failure_log.request_id');
  }
  const id = nextId(t, 'failure_log');
  t.failures.push({
    id,
    ts,
    tenantId: event.tenantId,
    sessionId: event.sessionId?.slice(0, MAX_HOOK_FIELD_LEN) ?? null,
    tool: event.tool?.slice(0, MAX_HOOK_FIELD_LEN) ?? null,
    outcome: event.outcome,
    rule: event.rule ?? null,
    sigHash: event.sigHash ?? null,
    detailHash: event.detailHash ?? null,
    ownerSubject: event.ownerSubject ?? null,
    originProject: event.originProject ?? null,
    requestId,
  });
  return id;
}

function requestOutcomeIn(t: MemoryTables, tenantId: string, requestId: string, sessionId: string) {
  const row = byRequest(t, tenantId, requestId);
  if (row === undefined) return null;
  if (row.sessionId !== sessionId.slice(0, MAX_HOOK_FIELD_LEN)) {
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

const RATED: ReadonlySet<FailureOutcome> = new Set(['stored', 'duplicate', 'store-failed']);

/** The tenant's failure totals since `sinceIso`, with repeats counted per session by base/records/failure-repeats. */
export function failureSummary(t: MemoryTables, tenantId: string, sinceIso: string): FailureSummary {
  const mine = t.failures.filter((r) => r.tenantId === tenantId);
  const inWindow = mine.filter((r) => byBytes(r.ts, sinceIso) >= 0);
  const count = (outcome: FailureOutcome): number => inWindow.filter((r) => r.outcome === outcome).length;
  const outcomes = {
    stored: count('stored'),
    duplicate: count('duplicate'),
    'store-failed': count('store-failed'),
    'skipped-interrupt': count('skipped-interrupt'),
    'skipped-routine': count('skipped-routine'),
    'skipped-invalid': count('skipped-invalid'),
  } satisfies Record<FailureOutcome, number>;
  const rated = [...mine]
    .sort((a, b) => a.id - b.id)
    .flatMap((r) =>
      r.sessionId !== null && r.sigHash !== null && RATED.has(r.outcome)
        ? [{ ts: r.ts, sessionId: r.sessionId, sigHash: r.sigHash }]
        : [],
    );
  const sessions = failuresPerSession(rated, sinceIso);
  return {
    since: sinceIso,
    outcomes,
    total: Object.values(outcomes).reduce((sum, n) => sum + n, 0),
    rated: sessions.reduce((sum, s) => sum + s.failures, 0),
    repeats: sessions.reduce((sum, s) => sum + s.repeats, 0),
    sessions: sessions.length,
  };
}
