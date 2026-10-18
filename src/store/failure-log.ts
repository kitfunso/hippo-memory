/** Failure log: every failed tool call the capture-error hook sees, stored or not. */
import { ConflictError } from '../core/api-errors.js';
import type { DatabaseSyncLike } from '../db/index.js';
import { DAY_MS } from '../util/time.js';
import type { FailureEvent, FailureOutcome } from './port/failure-log.js';
import { FAILURE_LOG_RETENTION_DAYS } from '../core/failure-log-retention.js';
import type { FailureSummary } from './port/failure-log.js';

/** Longest session id or tool name kept; the hook payload is not trusted to be short. */
const MAX_FIELD = 128;

/** Prune rows past {@link FAILURE_LOG_RETENTION_DAYS}, then append one failure row; returns the new row's id. */
export function recordFailure(db: DatabaseSyncLike, event: FailureEvent): number {
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
      event.sessionId?.slice(0, MAX_FIELD) ?? null,
      event.tool?.slice(0, MAX_FIELD) ?? null,
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
    .get<{ outcome: FailureOutcome; session_id: string | null } | undefined>(tenantId, requestId);
  if (row === undefined) return null;
  // Sessions are owner-bound, so this also keeps one owner from reading or settling another's row; compared as stored.
  if (row.session_id !== sessionId.slice(0, MAX_FIELD)) {
    throw new ConflictError('request id belongs to another session');
  }
  return row.outcome;
}

/** A retry that stored what the first try could not rewrites that row, since the request id allows one row per
 * tenant. */
export function settleFailureOutcome(
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

/** Rated failures and repeats in one session, for {@link failuresBySession}. */
export interface SessionFailures {
  sessionId: string;
  /** Failures hippo treats as lessons (stored, duplicate or store-failed) in the window. */
  failures: number;
  /** Of those, failures whose signature another session hit first. */
  repeats: number;
}

/** Rated failures per session since `sinceIso`, the input for repeat-error rate per arm. */
export function failuresBySession(db: DatabaseSyncLike, tenantId: string, sinceIso: string): SessionFailures[] {
  // SAFETY: the SELECT names exactly these three TEXT columns.
  const rows = db
    .prepare(
      `SELECT ts, session_id, sig_hash FROM failure_log
     WHERE tenant_id = ? AND session_id IS NOT NULL AND sig_hash IS NOT NULL
       AND outcome IN ('stored', 'duplicate', 'store-failed')
     ORDER BY id`,
    )
    .all(tenantId) as Array<{ ts: string; session_id: string; sig_hash: string }>;
  const firstSession = new Map<string, string>();
  const bySession = new Map<string, SessionFailures>();
  for (const row of rows) {
    if (!firstSession.has(row.sig_hash)) firstSession.set(row.sig_hash, row.session_id);
    // Rows before the window are not counted but still decide which session hit a signature first.
    if (row.ts < sinceIso) continue;
    const repeat = firstSession.get(row.sig_hash) !== row.session_id;
    const s = bySession.get(row.session_id) ?? { sessionId: row.session_id, failures: 0, repeats: 0 };
    bySession.set(row.session_id, { ...s, failures: s.failures + 1, repeats: s.repeats + (repeat ? 1 : 0) });
  }
  return [...bySession.values()];
}

/** Failed tool calls logged since `sinceIso`, in every tenant; throws when the table is missing. */
export function countFailuresSince(db: DatabaseSyncLike, sinceIso: string): number {
  // SAFETY: COUNT aggregate row.
  const row = db.prepare(`SELECT COUNT(*) AS n FROM failure_log WHERE ts >= ?`).get(sinceIso) as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

/** Sum the failure log for one tenant since `sinceIso`. */
export function summarizeFailures(db: DatabaseSyncLike, tenantId: string, sinceIso: string): FailureSummary {
  // SAFETY: the SELECT names exactly these two columns, TEXT and an aggregate.
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
