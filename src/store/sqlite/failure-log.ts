// hippo.db's FailureLog group: every failed tool call the capture-error hook sees, stored or not, each call on a handle
// of its own.
import { ConflictError } from '../../base/errors/api-errors.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import { MAX_HOOK_FIELD_LEN } from '../../base/util/limits.js';
import { DAY_MS } from '../../base/util/time.js';
import type { FailureEvent, FailureOutcome, FailureSummary, FailureLog } from '../port/failure-log.js';
import { FAILURE_LOG_RETENTION_DAYS } from '../../base/records/failure-log-retention.js';
import { failuresPerSession, type SessionFailures } from '../../base/records/failure-repeats.js';
import type { OnHandle } from './open.js';
import { bound, type Bodies } from './bound.js';
import type { Sync } from './served.js';

/** Prune rows past {@link FAILURE_LOG_RETENTION_DAYS}, then append one failure row; returns the new row's id. */
function recordFailure(db: DatabaseSyncLike, event: FailureEvent): number {
  // Normalized, because the window and prune compare timestamps as strings.
  const now = new Date(event.now ?? Date.now()).toISOString();
  // Prune first: nothing after the insert can throw, so a returned id always means a committed row.
  const cutoff = new Date(Date.parse(now) - FAILURE_LOG_RETENTION_DAYS * DAY_MS).toISOString();
  db.prepare(`DELETE FROM failure_log WHERE ts < ?`).run(cutoff);
  const inserted = db
    .prepare(
      `INSERT INTO failure_log (ts, tenant_id, session_id, tool, outcome, skip_rule, sig_hash, detail_hash, ` +
        `owner_subject, origin_project, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now,
      event.tenantId,
      event.sessionId?.slice(0, MAX_HOOK_FIELD_LEN) ?? null,
      event.tool?.slice(0, MAX_HOOK_FIELD_LEN) ?? null,
      event.outcome,
      event.rule ?? null,
      event.sigHash ?? null,
      event.detailHash ?? null,
      event.ownerSubject ?? null,
      event.originProject ?? null,
      event.requestId ?? null,
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
  const row = db
    .prepare(`SELECT outcome, session_id FROM failure_log WHERE tenant_id = ? AND request_id = ?`)
    .get(tenantId, requestId) as { outcome: FailureOutcome; session_id: string | null } | undefined;
  if (row === undefined) return null;
  // Sessions are owner-bound, so this also keeps one owner from reading or settling another's row; compared as stored.
  if (row.session_id !== sessionId.slice(0, MAX_HOOK_FIELD_LEN)) {
    throw new ConflictError('request id belongs to another session');
  }
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
  db.prepare(`UPDATE failure_log SET outcome = ? WHERE tenant_id = ? AND request_id = ?`).run(
    outcome,
    tenantId,
    requestId,
  );
}

/** The tenant's rated failures per session since `sinceIso`, under the rule in base/records/failure-repeats.ts. */
function failuresBySession(db: DatabaseSyncLike, tenantId: string, sinceIso: string): SessionFailures[] {
  const rows = db
    .prepare(
      `SELECT ts, session_id, sig_hash FROM failure_log
     WHERE tenant_id = ? AND session_id IS NOT NULL AND sig_hash IS NOT NULL
       AND outcome IN ('stored', 'duplicate', 'store-failed')
     ORDER BY id`,
    )
    .all(tenantId) as Array<{ ts: string; session_id: string; sig_hash: string }>;
  const rated = rows.map((r) => ({ ts: r.ts, sessionId: r.session_id, sigHash: r.sig_hash }));
  return failuresPerSession(rated, sinceIso);
}

/** Failed tool calls logged since `sinceIso`, in every tenant; throws when the table is missing. */
export function countFailuresSince(db: DatabaseSyncLike, sinceIso: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM failure_log WHERE ts >= ?`).get(sinceIso) as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

/** Sum the failure log for one tenant since `sinceIso`. */
export function summarizeFailures(db: DatabaseSyncLike, tenantId: string, sinceIso: string): FailureSummary {
  const rows = db
    .prepare(`SELECT outcome, COUNT(*) AS n FROM failure_log WHERE tenant_id = ? AND ts >= ? GROUP BY outcome`)
    .all(tenantId, sinceIso) as Array<{ outcome: string; n: number }>;
  const counts = new Map(rows.map((r) => [r.outcome, Number(r.n)] as const));
  const outcomes = {
    stored: counts.get('stored') ?? 0,
    duplicate: counts.get('duplicate') ?? 0,
    'store-failed': counts.get('store-failed') ?? 0,
    'skipped-interrupt': counts.get('skipped-interrupt') ?? 0,
    'skipped-routine': counts.get('skipped-routine') ?? 0,
    'skipped-invalid': counts.get('skipped-invalid') ?? 0,
  } satisfies Record<FailureOutcome, number>;
  const sessions = failuresBySession(db, tenantId, sinceIso);
  return {
    since: sinceIso,
    outcomes,
    total: Object.values(outcomes).reduce((sum, n) => sum + n, 0),
    rated: sessions.reduce((sum, s) => sum + s.failures, 0),
    repeats: sessions.reduce((sum, s) => sum + s.repeats, 0),
    sessions: sessions.length,
  };
}

const failureLogAt: Bodies<FailureLog> = {
  record: recordFailure,
  requestOutcome,
  settleOutcome: settleFailureOutcome,
};

export function sqliteFailureLog(on: OnHandle): Sync<FailureLog> {
  return bound(on, failureLogAt);
}
