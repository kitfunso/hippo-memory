/** Failure log (ROADMAP CD13): every failed tool call the capture-error hook sees, stored or not. */
import type { CaptureErrorOutcome, RoutineRule } from './capture-error.js';
import type { DatabaseSyncLike } from './db.js';

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
  /** Override the timestamp (tests). ISO string. */
  now?: string;
}

/** Append one failure row and prune rows past {@link FAILURE_LOG_RETENTION_DAYS}. */
export function recordFailure(db: DatabaseSyncLike, event: FailureEvent): void {
  // Normalised, because the window and prune compare timestamps as strings.
  const now = new Date(event.now ?? Date.now()).toISOString();
  db.prepare(
    `INSERT INTO failure_log (ts, tenant_id, session_id, tool, outcome, skip_rule, sig_hash, detail_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now,
    event.tenantId,
    event.sessionId?.slice(0, MAX_FIELD) ?? null,
    event.tool?.slice(0, MAX_FIELD) ?? null,
    event.outcome,
    event.rule ?? null,
    event.sigHash ?? null,
    event.detailHash ?? null,
  );
  const cutoff = new Date(Date.parse(now) - FAILURE_LOG_RETENTION_DAYS * 86_400_000).toISOString();
  db.prepare(`DELETE FROM failure_log WHERE ts < ?`).run(cutoff);
}

/** Rated failures and repeats in one session, for {@link failuresBySession}. */
export interface SessionFailures {
  sessionId: string;
  /** Failures hippo treats as lessons (stored, duplicate or store-failed) in the window. */
  failures: number;
  /** Of those, failures whose signature another session hit first. */
  repeats: number;
}

/** Rated failures per session since `sinceIso`, the input for repeat-error rate per arm (CD11, CD12). */
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

/** Failure log totals over a window, for {@link summarizeFailures}. Counts only: a rate needs a holdout arm (CD11). */
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
