// hippo.db's FailureLog group: every failed tool call the capture-error hook sees, stored or not,
// each call on a handle of its own.
import { otherSessionsRequest } from '../../rules/request-ids.js';
import type { DatabaseSyncLike } from '../../../db/index.js';
import type {
  FailureEvent,
  FailureOutcome,
  FailureSummary,
  FailureLog,
  RoutineRule,
} from '../../../base/ports/store/rejections.js';
import { type RatedFailure, failuresPerSession } from '../../../base/records/failure-repeats.js';
import type { OnHandle } from '../runtime/open.js';
import { bound, type Bodies } from '../runtime/bound.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { FAILURE_LOG_RETENTION_DAYS } from '../../../base/records/failure-log-retention.js';
import { MAX_HOOK_FIELD_LEN } from '../../../base/util/limits.js';
import { DAY_MS } from '../../../base/util/time.js';
import { handleNow } from '../runtime/handle-clock.js';

// The failure log's row and totals: what a failure stores, how long it stays, and how a
// window's outcomes and repeats add up.

/** The outcomes a repeat is counted among: a failure the hook judged worth a lesson. */
const RATED_OUTCOMES: readonly FailureOutcome[] = ['stored', 'duplicate', 'store-failed'];

/** A failure_log row as it is stored, without its id. */
interface FailureRow {
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

/** The row `event` stores, stamped in toISOString form since the window and prune compare stamps
 * as text. */
function failureRow(event: FailureEvent, fallbackNow: Date): FailureRow {
  return {
    ts: new Date(event.now ?? fallbackNow.getTime()).toISOString(),
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
const retentionCutoff = (ts: string): string =>
  new Date(Date.parse(ts) - FAILURE_LOG_RETENTION_DAYS * DAY_MS).toISOString();

/** A request's stored session matches the caller's only as stored: cut to the column's length. */
const sameStoredSession = (stored: string | null, sessionId: string): boolean =>
  stored === sessionId.slice(0, MAX_HOOK_FIELD_LEN);

/** The window's totals from its per-outcome counts and the tenant's rated rows in id order, the
 * earlier ones too. */
function failureTotals(
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

/** Prune rows past {@link FAILURE_LOG_RETENTION_DAYS}, then append one failure row; returns the
 * new row's id. */
function recordFailure(db: DatabaseSyncLike, event: FailureEvent): number {
  const row = failureRow(event, handleNow(db));
  // Prune first: nothing after the insert can throw, so a returned id always means a committed row.
  cachedStatement(db, `DELETE FROM failure_log WHERE ts < ?`).run(retentionCutoff(row.ts));
  const inserted = cachedStatement(
    db,
    `INSERT INTO failure_log (ts, tenant_id, session_id, tool, outcome, skip_rule, sig_hash, detail_hash, ` +
      `owner_subject, origin_project, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.ts,
    row.tenantId,
    row.sessionId,
    row.tool,
    row.outcome,
    row.rule,
    row.sigHash,
    row.detailHash,
    row.ownerSubject,
    row.originProject,
    row.requestId,
  );
  return Number(inserted.lastInsertRowid);
}

/** The outcome logged for a caller's request id, or null, so a retried send finds the first one;
 * another session's id is a ConflictError. */
export function requestOutcome(
  db: DatabaseSyncLike,
  tenantId: string,
  requestId: string,
  sessionId: string,
): FailureOutcome | null {
  const row = cachedStatement(
    db,
    `SELECT outcome, session_id FROM failure_log WHERE tenant_id = ? AND request_id = ?`,
  ).get(tenantId, requestId) as { outcome: FailureOutcome; session_id: string | null } | undefined;
  if (row === undefined) return null;
  if (!sameStoredSession(row.session_id, sessionId)) throw otherSessionsRequest();
  return row.outcome;
}

/**
 * A retry that stored what the first try could not rewrites that row, since the request id allows
 * one row per tenant.
 */
function settleFailureOutcome(
  db: DatabaseSyncLike,
  tenantId: string,
  requestId: string,
  outcome: FailureOutcome,
): void {
  cachedStatement(
    db,
    `UPDATE failure_log SET outcome = ? WHERE tenant_id = ? AND request_id = ?`,
  ).run(outcome, tenantId, requestId);
}

/** The tenant's rated failures in id order, the ones before the window too: they decide which
 * session hit first. */
function ratedFailures(db: DatabaseSyncLike, tenantId: string): RatedFailure[] {
  const rows = cachedStatement(
    db,
    `SELECT ts, session_id, sig_hash FROM failure_log
     WHERE tenant_id = ? AND session_id IS NOT NULL AND sig_hash IS NOT NULL
       AND outcome IN (SELECT value FROM json_each(?))
     ORDER BY id`,
  ).all(tenantId, JSON.stringify(RATED_OUTCOMES)) as Array<{
    ts: string;
    session_id: string;
    sig_hash: string;
  }>;
  return rows.map((r) => ({ ts: r.ts, sessionId: r.session_id, sigHash: r.sig_hash }));
}

/** Failed tool calls logged since `sinceIso`, in every tenant; throws when the table is missing. */
export function countFailuresSince(db: DatabaseSyncLike, sinceIso: string): number {
  const row = cachedStatement(db, `SELECT COUNT(*) AS n FROM failure_log WHERE ts >= ?`).get(
    sinceIso,
  ) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Sum the failure log for one tenant since `sinceIso`. */
export function summarizeFailures(
  db: DatabaseSyncLike,
  tenantId: string,
  sinceIso: string,
): FailureSummary {
  const rows = cachedStatement(
    db,
    `SELECT outcome, COUNT(*) AS n FROM failure_log WHERE tenant_id = ? AND ts >= ? GROUP BY outcome`,
  ).all(tenantId, sinceIso) as Array<{ outcome: string; n: number }>;
  const counts = new Map(rows.map((r) => [r.outcome, Number(r.n)] as const));
  return failureTotals(
    sinceIso,
    (outcome) => counts.get(outcome) ?? 0,
    ratedFailures(db, tenantId),
  );
}

const failureLogBodies: Bodies<FailureLog> = {
  record: recordFailure,
  requestOutcome,
  settleOutcome: settleFailureOutcome,
};

export function sqliteFailureLog(on: OnHandle): FailureLog {
  return bound(on, failureLogBodies);
}
