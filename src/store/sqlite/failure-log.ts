// hippo.db's FailureLog group: every failed tool call the capture-error hook sees, stored or not, each call on a handle
// of its own.
import { otherSessionsRequest } from '../rules/request-ids.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import type { FailureEvent, FailureOutcome, FailureSummary, FailureLog } from '../port/rejections.js';
import type { RatedFailure } from '../../base/records/failure-repeats.js';
import { failureRow, failureTotals, RATED_OUTCOMES, retentionCutoff, sameStoredSession } from '../rules/failure-log.js';
import type { OnHandle } from './open.js';
import { bound, type Bodies } from './bound.js';
import { cachedStatement } from '../../db/statement-cache.js';

/** Prune rows past {@link FAILURE_LOG_RETENTION_DAYS}, then append one failure row; returns the new row's id. */
function recordFailure(db: DatabaseSyncLike, event: FailureEvent): number {
  const row = failureRow(event);
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

/** The outcome logged for a caller's request id, or null, so a retried send finds the first one; another session's id
 * is a ConflictError. */
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
 * A retry that stored what the first try could not rewrites that row, since the request id allows one row per tenant.
 */
function settleFailureOutcome(
  db: DatabaseSyncLike,
  tenantId: string,
  requestId: string,
  outcome: FailureOutcome,
): void {
  cachedStatement(db, `UPDATE failure_log SET outcome = ? WHERE tenant_id = ? AND request_id = ?`).run(
    outcome,
    tenantId,
    requestId,
  );
}

/** The tenant's rated failures in id order, the ones before the window too: they decide which session hit first. */
function ratedFailures(db: DatabaseSyncLike, tenantId: string): RatedFailure[] {
  const rows = cachedStatement(
    db,
    `SELECT ts, session_id, sig_hash FROM failure_log
     WHERE tenant_id = ? AND session_id IS NOT NULL AND sig_hash IS NOT NULL
       AND outcome IN (SELECT value FROM json_each(?))
     ORDER BY id`,
  ).all(tenantId, JSON.stringify(RATED_OUTCOMES)) as Array<{ ts: string; session_id: string; sig_hash: string }>;
  return rows.map((r) => ({ ts: r.ts, sessionId: r.session_id, sigHash: r.sig_hash }));
}

/** Failed tool calls logged since `sinceIso`, in every tenant; throws when the table is missing. */
export function countFailuresSince(db: DatabaseSyncLike, sinceIso: string): number {
  const row = cachedStatement(db, `SELECT COUNT(*) AS n FROM failure_log WHERE ts >= ?`).get(sinceIso) as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

/** Sum the failure log for one tenant since `sinceIso`. */
export function summarizeFailures(db: DatabaseSyncLike, tenantId: string, sinceIso: string): FailureSummary {
  const rows = cachedStatement(
    db,
    `SELECT outcome, COUNT(*) AS n FROM failure_log WHERE tenant_id = ? AND ts >= ? GROUP BY outcome`,
  ).all(tenantId, sinceIso) as Array<{ outcome: string; n: number }>;
  const counts = new Map(rows.map((r) => [r.outcome, Number(r.n)] as const));
  return failureTotals(sinceIso, (outcome) => counts.get(outcome) ?? 0, ratedFailures(db, tenantId));
}

const failureLogBodies: Bodies<FailureLog> = {
  record: recordFailure,
  requestOutcome,
  settleOutcome: settleFailureOutcome,
};

export function sqliteFailureLog(on: OnHandle): FailureLog {
  return bound(on, failureLogBodies);
}
