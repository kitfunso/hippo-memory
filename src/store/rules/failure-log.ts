// The failure log's row and totals, once for both adapters: what a failure stores, how long it stays, and how a
// window's outcomes and repeats add up.
import { FAILURE_LOG_RETENTION_DAYS } from '../../base/records/failure-log-retention.js';
import { failuresPerSession, type RatedFailure } from '../../base/records/failure-repeats.js';
import { MAX_HOOK_FIELD_LEN } from '../../base/util/limits.js';
import { DAY_MS } from '../../base/util/time.js';
import type { FailureEvent, FailureOutcome, FailureSummary, RoutineRule } from '../port/failure-log.js';

/** The outcomes a repeat is counted among: a failure the hook judged worth a lesson. */
export const RATED_OUTCOMES: readonly FailureOutcome[] = ['stored', 'duplicate', 'store-failed'];

/** A failure_log row as it is stored, without its id. */
export interface FailureRow {
  readonly ts: string;
  readonly tenantId: string;
  readonly sessionId: string | null;
  readonly tool: string | null;
  readonly outcome: FailureOutcome;
  readonly rule: RoutineRule | null;
  readonly sigHash: string | null;
  readonly detailHash: string | null;
  readonly ownerSubject: string | null;
  readonly originProject: string | null;
  readonly requestId: string | null;
}

/** The row `event` stores, stamped in toISOString form since the window and prune compare stamps as text. */
export function failureRow(event: FailureEvent): FailureRow {
  return {
    ts: new Date(event.now ?? Date.now()).toISOString(),
    tenantId: event.tenantId,
    sessionId: event.sessionId?.slice(0, MAX_HOOK_FIELD_LEN) ?? null,
    tool: event.tool?.slice(0, MAX_HOOK_FIELD_LEN) ?? null,
    outcome: event.outcome,
    rule: event.rule ?? null,
    sigHash: event.sigHash ?? null,
    detailHash: event.detailHash ?? null,
    ownerSubject: event.ownerSubject ?? null,
    originProject: event.originProject ?? null,
    requestId: event.requestId ?? null,
  };
}

/** The stamp before which a row written at `ts` prunes the log. */
export const retentionCutoff = (ts: string): string =>
  new Date(Date.parse(ts) - FAILURE_LOG_RETENTION_DAYS * DAY_MS).toISOString();

/** A request's stored session matches the caller's only as stored: cut to the column's length. */
export const sameStoredSession = (stored: string | null, sessionId: string): boolean =>
  stored === sessionId.slice(0, MAX_HOOK_FIELD_LEN);

/** The window's totals from its per-outcome counts and the tenant's rated rows in id order, the earlier ones too. */
export function failureTotals(
  sinceIso: string,
  count: (outcome: FailureOutcome) => number,
  rated: readonly RatedFailure[],
): FailureSummary {
  const outcomes = {
    stored: count('stored'),
    duplicate: count('duplicate'),
    'store-failed': count('store-failed'),
    'skipped-interrupt': count('skipped-interrupt'),
    'skipped-routine': count('skipped-routine'),
    'skipped-invalid': count('skipped-invalid'),
  } satisfies Record<FailureOutcome, number>;
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
