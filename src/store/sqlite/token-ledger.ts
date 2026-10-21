/** Token ledger: one row per block of memory text sent to an agent on any surface, with its token cost; the input for
 * the token-savings evals. Backs inject-only-on-change: the hook records a `skip` when the block hash matches the
 * session's last; `reread` rows cover {@link REREAD_SURFACES} blocks. Counts use {@link estimateTokens} (chars / 4);
 * rows never hold content or query text. Writes are best-effort: a ledger failure must not break recall. */
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { DAY_MS } from '../../base/util/time.js';
import {
  countSkipsAfter,
  deleteRereadRows,
  injectedBlocks,
  insertTokenRow,
  latestInjectOrReset,
  pruneTokenRowsBefore,
  sessionTokenRows,
  sessionTotals,
  surfaceTotals,
} from './token-ledger-rows.js';
import { DATE_PREFIX_CHARS } from '../../base/util/token-text.js';
import type { TokenSummary, TokenSurface, TokenSurfaceSummary, TokenUse } from '../port/token-ledger.js';
import type { LastSent } from '../../base/session/skip-unchanged.js';
import type { ApiCall } from '../../base/session/transcript-calls.js';

/** All surfaces, in report order. */
const TOKEN_SURFACES: readonly TokenSurface[] = [
  'hook',
  'hook_recall',
  'compact_resume',
  'context',
  'recall',
  'mcp_recall',
  'mcp_context',
  'http_recall',
  'http_context',
  'http_assemble',
];

/** Surfaces whose re-reads are counted: only a hook payload tells a sub-agent's block from its parent's, as both carry
 * one session id. */
const REREAD_SURFACES: readonly TokenSurface[] = ['hook', 'hook_recall', 'compact_resume'];

/** Rows older than this are pruned on write. */
const TOKEN_LEDGER_RETENTION_DAYS = 90;

/** Append one ledger row and prune rows past {@link TOKEN_LEDGER_RETENTION_DAYS}. */
export function recordTokenUse(db: DatabaseSyncLike, use: TokenUse): void {
  const now = use.now ?? new Date().toISOString();
  insertTokenRow(db, {
    ts: now,
    tenantId: use.tenantId,
    sessionId: use.sessionId ?? null,
    surface: use.surface,
    event: use.event,
    items: Math.max(0, Math.round(use.items)),
    tokens: Math.max(0, Math.round(use.tokens)),
    blockHash: use.hash ?? null,
  });
  const cutoff = new Date(Date.parse(now) - TOKEN_LEDGER_RETENTION_DAYS * DAY_MS).toISOString();
  pruneTokenRowsBefore(db, cutoff);
}

/** The last block this session injected on `surface`, or null if none, a `reset` came after it, or there is no session
 * id (the caller then always injects). */
export function lastSentState(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string | null | undefined,
  surface: TokenSurface,
): LastSent | null {
  if (!sessionId) return null;
  const anchor = latestInjectOrReset(db, tenantId, sessionId, surface);
  if (!anchor || anchor.event === 'reset' || !anchor.block_hash) return null;
  const skips = countSkipsAfter(db, tenantId, sessionId, surface, anchor.id);
  return { hash: anchor.block_hash, skipsSince: Number(skips?.n ?? 0) };
}

/** Sum the ledger for one tenant since `sinceIso`; surfaces with no rows are omitted. */
export function summarizeTokenUse(db: DatabaseSyncLike, tenantId: string, sinceIso: string): TokenSummary {
  const rows = surfaceTotals(db, tenantId, sinceIso);
  const bySurface = new Map(rows.map((r) => [r.surface, r]));
  const surfaces: TokenSurfaceSummary[] = [];
  for (const surface of TOKEN_SURFACES) {
    const r = bySurface.get(surface);
    if (!r) continue;
    surfaces.push({
      surface,
      injected: Number(r.injected),
      tokens: Number(r.tokens),
      skipped: Number(r.skipped),
      tokensAvoided: Number(r.avoided),
      tokensReread: Number(r.reread),
      sessions: Number(r.sessions),
    });
  }
  const perSession = sessionTotals(db, tenantId, sinceIso, REREAD_SURFACES);
  const sessionCount = Number(perSession?.sessions ?? 0);
  const sessionTokens = Number(perSession?.tokens ?? 0);
  return {
    since: sinceIso,
    surfaces,
    totalTokens: surfaces.reduce((s, x) => s + x.tokens, 0),
    totalTokensAvoided: surfaces.reduce((s, x) => s + x.tokensAvoided, 0),
    totalTokensReread: surfaces.reduce((s, x) => s + x.tokensReread, 0),
    meanTokensPerSession: sessionCount > 0 ? Math.round(sessionTokens / sessionCount) : 0,
    sessions: sessionCount,
    hookSessions: Number(perSession?.hook_sessions ?? 0),
    rereadSessions: Number(perSession?.reread_sessions ?? 0),
  };
}

/** Tokens hippo sent and skipped in one session, for {@link tokensBySession}. */
interface SessionTokens {
  sessionId: string;
  /** Tokens of memory text sent to the agent. */
  sent: number;
  /** Tokens of unchanged blocks not sent. */
  skipped: number;
  /** Blocks sent. */
  injections: number;
}

/** Ledger totals per session id since `sinceIso`, across surfaces; hook rows carry the host's session id (the
 * transcript file name), so they join to its usage records. */
export function tokensBySession(db: DatabaseSyncLike, tenantId: string, sinceIso: string): SessionTokens[] {
  return sessionTokenRows(db, tenantId, sinceIso).map((r) => ({
    sessionId: r.session_id,
    sent: Number(r.sent),
    skipped: Number(r.skipped),
    injections: Number(r.injections),
  }));
}

/** Calls that carried a block sent at `at` (epoch ms): every later call in the first later call's context window. */
export function carryingCalls(calls: readonly ApiCall[], at: number): ApiCall[] {
  // Windows come from file order, not boundary timestamps: the compact-resume block is booked before its boundary's
  // timestamp.
  const first = calls.find((call) => call.at > at);
  if (!first) return [];
  return calls.filter((call) => call.at > at && call.compactions === first.compactions);
}

/** A surface's re-reads on one UTC day; `at` is the day's last carrying call or send and dates the row. */
interface RereadDay {
  surface: TokenSurface;
  at: number;
  rereads: number;
  tokens: number;
}

/** Replace a session's `reread` rows in `hippoRoot`'s store, one per {@link REREAD_SURFACES} surface and UTC day;
 * returns the tokens booked. One transaction, so a refused row leaves the session's earlier re-read rows in place. */
export function recordRereadsAt(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  calls: readonly ApiCall[],
): number {
  return withWriteScope(db, 'record_rereads', () => {
    const rows = injectedBlocks(db, tenantId, sessionId, REREAD_SURFACES);
    const days = new Map<string, RereadDay>();
    const add = (surface: TokenSurface, at: number, rereads: number, tokens: number): void => {
      const key = `${surface} ${new Date(at).toISOString().slice(0, DATE_PREFIX_CHARS)}`;
      const day = days.get(key) ?? { surface, at, rereads: 0, tokens: 0 };
      days.set(key, { surface, at: Math.max(day.at, at), rereads: day.rereads + rereads, tokens: day.tokens + tokens });
    };
    for (const row of rows) {
      const sentAt = Date.parse(row.ts);
      // Dated by when the calls happened, so a --days window counts re-reads in it; the empty send-day row keeps the
      // session in coverage.
      add(row.surface, sentAt, 0, 0);
      // The first carrying call is the send itself; every later one is a re-read.
      for (const call of carryingCalls(calls, sentAt).slice(1)) add(row.surface, call.at, 1, Number(row.tokens));
    }
    deleteRereadRows(db, tenantId, sessionId);
    for (const day of days.values()) {
      recordTokenUse(db, {
        tenantId,
        sessionId,
        surface: day.surface,
        event: 'reread',
        items: day.rereads,
        tokens: day.tokens,
        now: new Date(day.at).toISOString(),
      });
    }
    return [...days.values()].reduce((sum, day) => sum + day.tokens, 0);
  });
}
