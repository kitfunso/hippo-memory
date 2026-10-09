/** Failure log: every failed tool call the capture-error hook sees, stored or not. */
import { ConflictError } from '../api-errors.js';
import type { DatabaseSyncLike } from '../db.js';
import { DAY_MS } from '../util/time.js';

/** Why a failure was not stored, or `stored`. */
export type CaptureErrorOutcome = 'stored' | 'duplicate' | 'skipped-interrupt' | 'skipped-routine' | 'skipped-invalid';

/** Which routine check skipped a failure; the log keeps it so declines can be told apart from empty searches. */
export type RoutineRule = 'declined' | 'os-permission' | 'no-match' | 'search-tool' | 'quiet-exit';

/** Rows older than this are pruned on write, which also bounds how far back a repeat can be found. */
export const FAILURE_LOG_RETENTION_DAYS = 90;

/** A capture-error outcome, or `store-failed` when storing the lesson threw. */
export type FailureOutcome = CaptureErrorOutcome | 'store-failed';

/** Longest session id or tool name kept; the hook payload is not trusted to be short. */
const MAX_FIELD = 128;

/** One failed tool call, for {@link recordFailure}. Never the failure text: it can carry paths and secrets. */
export interface FailureEvent {
  tenantId: string;
  /** Host session id from the hook payload; null when it had none. */
  sessionId?: string | null;
  tool?: string | null;
  outcome: FailureOutcome;
  /** The routine check that skipped it, for `skipped-routine`. */
  rule?: RoutineRule | null;
  /** Hash of the lesson text's signature, the key dedupe uses; null when the payload had no readable error. */
  sigHash?: string | null;
  /** Hash of the untruncated error plus the command's first two words, finer than `sigHash`. */
  detailHash?: string | null;
  /** A shared-store caller's owner and project; null on a local store. */
  ownerSubject?: string | null;
  originProject?: string | null;
  /** The client's queue record id, so a retried send finds the earlier row. */
  requestId?: string | null;
  /** Override the timestamp (tests). ISO string. */
  now?: string;
}

/** Append one failure row and prune rows past {@link FAILURE_LOG_RETENTION_DAYS}. */
export function recordFailure(db: DatabaseSyncLike, event: FailureEvent): void {
  // Normalised, because the window and prune compare timestamps as strings.
  const now = new Date(event.now ?? Date.now()).toISOString();
  db.prepare(
    `INSERT INTO failure_log (ts, tenant_id, session_id, tool, outcome, skip_rule, sig_hash, detail_hash, owner_subject, origin_project, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  const cutoff = new Date(Date.parse(now) - FAILURE_LOG_RETENTION_DAYS * DAY_MS).toISOString();
  db.prepare(`DELETE FROM failure_log WHERE ts < ?`).run(cutoff);
}

/** The outcome logged for a caller's request id, or null, so a retried send finds the first one; another session's id is a ConflictError. */
export function requestOutcome(db: DatabaseSyncLike, tenantId: string, requestId: string, sessionId: string): FailureOutcome | null {
  const row = db.prepare(`SELECT outcome, session_id FROM failure_log WHERE tenant_id = ? AND request_id = ?`)
    .get<{ outcome: FailureOutcome; session_id: string | null } | undefined>(tenantId, requestId);
  if (row === undefined) return null;
  // Sessions are owner-bound, so this also keeps one owner from reading or settling another's row; compared as stored.
  if (row.session_id !== sessionId.slice(0, MAX_FIELD)) throw new ConflictError('request id belongs to another session');
  return row.outcome;
}

/** A retry that stored what the first try could not rewrites that row, since the request id allows one row per tenant. */
export function settleFailureOutcome(db: DatabaseSyncLike, tenantId: string, requestId: string, outcome: FailureOutcome): void {
  db.prepare(`UPDATE failure_log SET outcome = ? WHERE tenant_id = ? AND request_id = ?`).run(outcome, tenantId, requestId);
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
  const rows = db.prepare(
    `SELECT ts, session_id, sig_hash FROM failure_log
     WHERE tenant_id = ? AND session_id IS NOT NULL AND sig_hash IS NOT NULL
       AND outcome IN ('stored', 'duplicate', 'store-failed')
     ORDER BY id`,
  ).all(tenantId) as Array<{ ts: string; session_id: string; sig_hash: string }>;
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

/** Failure log totals over a window, for {@link summarizeFailures}. Counts only: a rate needs a holdout arm. */
export interface FailureSummary {
  /** ISO start of the window (inclusive). */
  since: string;
  outcomes: Record<FailureOutcome, number>;
  total: number;
  /** Rated failures from sessions with an id: the failures a repeat is counted among. */
  rated: number;
  repeats: number;
  sessions: number;
}

/** Sum the failure log for one tenant since `sinceIso`. */
export function summarizeFailures(db: DatabaseSyncLike, tenantId: string, sinceIso: string): FailureSummary {
  // SAFETY: the SELECT names exactly these two columns, TEXT and an aggregate.
  const rows = db.prepare(
    `SELECT outcome, COUNT(*) AS n FROM failure_log WHERE tenant_id = ? AND ts >= ? GROUP BY outcome`,
  ).all(tenantId, sinceIso) as Array<{ outcome: string; n: number }>;
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
