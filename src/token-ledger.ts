/**
 * Token ledger (ROADMAP Part IX, TE0): what memory text hippo hands agents,
 * and how many tokens it costs.
 *
 * One row per block of memory text sent to an agent, on every surface: the
 * per-prompt hook, `hippo context`, `hippo recall`, the MCP tools and the
 * HTTP API. The ledger answers the question a buyer asks first ("what does
 * this cost me per session?") and is the input for the token-savings evals.
 *
 * It also backs TE2, inject only on change: the per-prompt hook compares the
 * hash of the block it is about to send with the last block it sent in the
 * same session and records a `skip` instead of sending it again.
 *
 * Token counts use {@link estimateTokens} (characters / 4), the same estimate
 * every budget in hippo uses. Rows hold counts, surfaces, session ids and
 * hashes, never memory content or query text.
 *
 * DB-only helpers: the caller owns the handle. Writes are best-effort at the
 * call sites; a ledger failure must never break recall.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSyncLike } from './db.js';
import type { JsonObject, JsonValue } from './working-memory.js';

/**
 * Where a block of memory text was sent.
 * - `hook`: the per-prompt `UserPromptSubmit` hook (`hippo context --pinned-only`).
 * - `hook_recall`: the same hook's Z1 prompt-recall section (docs/plans/2026-09-26-z1-prompt-recall.md).
 * - `context`, `recall`: the CLI commands.
 * - `mcp_recall`, `mcp_context`: the MCP tools.
 * - `http_recall`, `http_context`, `http_assemble`: the HTTP API.
 */
export type TokenSurface =
  | 'hook'
  | 'hook_recall'
  | 'context'
  | 'recall'
  | 'mcp_recall'
  | 'mcp_context'
  | 'http_recall'
  | 'http_context'
  | 'http_assemble';

/** All surfaces, in report order. */
export const TOKEN_SURFACES: readonly TokenSurface[] = [
  'hook', 'hook_recall', 'context', 'recall', 'mcp_recall', 'mcp_context',
  'http_recall', 'http_context', 'http_assemble',
];

/**
 * What happened to a block.
 * - `inject`: sent to the agent.
 * - `skip`: identical to the session's last injected block, so not sent again.
 * - `reset`: the host compacted its context, so the next block must be sent.
 */
export type TokenEvent = 'inject' | 'skip' | 'reset';

/** Rows older than this are pruned on write. */
export const TOKEN_LEDGER_RETENTION_DAYS = 90;

/**
 * Rough token estimate: characters / 4. The single estimate behind every
 * token budget and ledger count in hippo.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Stable 16-hex-char hash of a rendered block, for change detection. */
export function blockHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** One ledger write. */
export interface TokenUse {
  tenantId: string;
  /** Host session id when known (hook payload, `HIPPO_SESSION_ID`); null otherwise. */
  sessionId?: string | null;
  surface: TokenSurface;
  event: TokenEvent;
  /** Memories (and continuity blocks) in the text. */
  items: number;
  /** Estimated tokens of the text; for a `skip`, the tokens not sent. */
  tokens: number;
  /** {@link blockHash} of the text, when the caller wants change detection. */
  hash?: string | null;
  /** Override the timestamp (tests). ISO string. */
  now?: string;
}

/**
 * Append one ledger row and prune rows past {@link TOKEN_LEDGER_RETENTION_DAYS}.
 */
export function recordTokenUse(db: DatabaseSyncLike, use: TokenUse): void {
  const now = use.now ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO token_ledger (ts, tenant_id, session_id, surface, event, items, tokens, block_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now,
    use.tenantId,
    use.sessionId ?? null,
    use.surface,
    use.event,
    Math.max(0, Math.round(use.items)),
    Math.max(0, Math.round(use.tokens)),
    use.hash ?? null,
  );
  const cutoff = new Date(Date.parse(now) - TOKEN_LEDGER_RETENTION_DAYS * 86_400_000).toISOString();
  db.prepare(`DELETE FROM token_ledger WHERE ts < ?`).run(cutoff);
}

/** What a session last sent on a surface, for {@link lastSentState}. */
export interface LastSent {
  /** {@link blockHash} of the last injected block. */
  hash: string;
  /** Consecutive `skip` rows since that injection. */
  skipsSince: number;
}

/**
 * The last block this session injected on `surface`, or null when the
 * session has injected nothing, a `reset` came after it, or there is no
 * session id (without one, the caller always injects).
 */
export function lastSentState(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string | null | undefined,
  surface: TokenSurface,
): LastSent | null {
  if (!sessionId) return null;
  // SAFETY: the SELECT names exactly these three columns.
  const anchor = db.prepare(
    `SELECT id, event, block_hash FROM token_ledger
     WHERE tenant_id = ? AND session_id = ? AND surface = ? AND event IN ('inject', 'reset')
     ORDER BY id DESC LIMIT 1`,
  ).get(tenantId, sessionId, surface) as { id: number; event: string; block_hash: string | null } | undefined;
  if (!anchor || anchor.event === 'reset' || !anchor.block_hash) return null;
  // SAFETY: the SELECT names exactly this one aggregate column.
  const skips = db.prepare(
    `SELECT COUNT(*) AS n FROM token_ledger
     WHERE tenant_id = ? AND session_id = ? AND surface = ? AND event = 'skip' AND id > ?`,
  ).get(tenantId, sessionId, surface, anchor.id) as { n: number } | undefined;
  return { hash: anchor.block_hash, skipsSince: Number(skips?.n ?? 0) };
}

/**
 * Whether a block identical to the session's last injection should be
 * skipped. `refreshTurns` resends an unchanged block after that many
 * consecutive skips, so a long session still sees its pinned rules near the
 * latest turn; 0 never resends an unchanged block.
 */
export function shouldSkipUnchanged(last: LastSent | null, hash: string, refreshTurns: number): boolean {
  if (!last || last.hash !== hash) return false;
  if (refreshTurns > 0 && last.skipsSince >= refreshTurns) return false;
  return true;
}

/** Per-surface totals for {@link summarizeTokenUse}. */
export interface TokenSurfaceSummary {
  surface: TokenSurface;
  /** Blocks sent. */
  injected: number;
  /** Tokens sent. */
  tokens: number;
  /** Blocks not sent because they were unchanged. */
  skipped: number;
  /** Tokens those skipped blocks would have cost. */
  tokensAvoided: number;
  /** Distinct session ids seen (rows without one are not counted). */
  sessions: number;
}

/** Ledger totals over a window. */
export interface TokenSummary {
  /** ISO start of the window (inclusive). */
  since: string;
  surfaces: TokenSurfaceSummary[];
  totalTokens: number;
  totalTokensAvoided: number;
  /** Mean tokens sent per session, over rows that carry a session id. */
  meanTokensPerSession: number;
}

/**
 * Sum the ledger for one tenant since `sinceIso`. Surfaces with no rows are
 * omitted.
 */
export function summarizeTokenUse(db: DatabaseSyncLike, tenantId: string, sinceIso: string): TokenSummary {
  // SAFETY: the SELECT names exactly these columns, all aggregates or TEXT.
  const rows = db.prepare(
    `SELECT surface,
            SUM(CASE WHEN event = 'inject' THEN 1 ELSE 0 END) AS injected,
            SUM(CASE WHEN event = 'inject' THEN tokens ELSE 0 END) AS tokens,
            SUM(CASE WHEN event = 'skip' THEN 1 ELSE 0 END) AS skipped,
            SUM(CASE WHEN event = 'skip' THEN tokens ELSE 0 END) AS avoided,
            COUNT(DISTINCT session_id) AS sessions
     FROM token_ledger
     WHERE tenant_id = ? AND ts >= ?
     GROUP BY surface`,
  ).all(tenantId, sinceIso) as Array<{
    surface: string; injected: number; tokens: number; skipped: number; avoided: number; sessions: number;
  }>;
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
      sessions: Number(r.sessions),
    });
  }
  // SAFETY: the SELECT names exactly these two aggregate columns.
  const perSession = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS sessions,
            SUM(CASE WHEN event = 'inject' THEN tokens ELSE 0 END) AS tokens
     FROM token_ledger
     WHERE tenant_id = ? AND ts >= ? AND session_id IS NOT NULL`,
  ).get(tenantId, sinceIso) as { sessions: number; tokens: number | null } | undefined;
  const sessionCount = Number(perSession?.sessions ?? 0);
  const sessionTokens = Number(perSession?.tokens ?? 0);
  return {
    since: sinceIso,
    surfaces,
    totalTokens: surfaces.reduce((s, x) => s + x.tokens, 0),
    totalTokensAvoided: surfaces.reduce((s, x) => s + x.tokensAvoided, 0),
    meanTokensPerSession: sessionCount > 0 ? Math.round(sessionTokens / sessionCount) : 0,
  };
}

/** JSON-value string check without a runtime `typeof` (anti-slop rule). */
function isJsonString(value: JsonValue | undefined): value is string {
  return value !== undefined && value !== null && value.constructor === String;
}

/** JSON-value plain-object check (excludes arrays and null). */
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && !Array.isArray(value) && value.constructor === Object;
}

/**
 * The `session_id` of a Claude Code hook payload on stdin, or null when the
 * text is empty, malformed, has no non-empty session id, or (with
 * `requiredSource`) a different `source`.
 */
export function hookPayloadSessionId(stdinText: string | undefined, requiredSource: string | null = null): string | null {
  if (!stdinText || stdinText.trim() === '') return null;
  let payload: JsonValue;
  try {
    // SAFETY: JSON.parse returns a JSON value by definition.
    payload = JSON.parse(stdinText.trim()) as JsonValue;
  } catch {
    return null;
  }
  if (!isJsonObject(payload)) return null;
  const sessionId = payload.session_id;
  if (!isJsonString(sessionId) || sessionId.trim() === '') return null;
  if (requiredSource !== null && payload.source !== requiredSource) return null;
  return sessionId;
}

/** Tokens hippo sent and skipped in one session, for {@link tokensBySession}. */
export interface SessionTokens {
  sessionId: string;
  /** Tokens of memory text sent to the agent. */
  sent: number;
  /** Tokens of unchanged blocks not sent. */
  skipped: number;
  /** Blocks sent. */
  injections: number;
}

/**
 * Ledger totals per session id since `sinceIso`, across every surface.
 * Claude Code hook rows carry the host's session id, which is also the
 * transcript file name, so these join to the host's own usage records.
 */
export function tokensBySession(db: DatabaseSyncLike, tenantId: string, sinceIso: string): SessionTokens[] {
  // SAFETY: the SELECT names exactly these columns, all aggregates or TEXT.
  const rows = db.prepare(
    `SELECT session_id,
            SUM(CASE WHEN event = 'inject' THEN tokens ELSE 0 END) AS sent,
            SUM(CASE WHEN event = 'skip' THEN tokens ELSE 0 END) AS skipped,
            SUM(CASE WHEN event = 'inject' THEN 1 ELSE 0 END) AS injections
     FROM token_ledger
     WHERE tenant_id = ? AND ts >= ? AND session_id IS NOT NULL
     GROUP BY session_id`,
  ).all(tenantId, sinceIso) as Array<{ session_id: string; sent: number; skipped: number; injections: number }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    sent: Number(r.sent),
    skipped: Number(r.skipped),
    injections: Number(r.injections),
  }));
}
