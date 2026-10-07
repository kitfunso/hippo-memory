/**
 * Token ledger: what memory text hippo hands agents,
 * and how many tokens it costs.
 *
 * One row per block of memory text sent to an agent, on every surface: the
 * per-prompt hook, the block `hippo compact-resume` restores after compaction,
 * `hippo context`, `hippo recall`, the MCP tools and the HTTP API. The ledger
 * answers the question a buyer asks first ("what does this cost me per
 * session?") and is the input for the token-savings evals.
 *
 * Every later model call re-reads a sent block until the host compacts; at session end the worker counts
 * those calls from the transcript as `reread` rows for the {@link REREAD_SURFACES} blocks, dated by call day.
 *
 * It also backs inject-only-on-change: the per-prompt hook compares the
 * hash of the block it is about to send with the last block it sent in the
 * same session and records a `skip` instead of sending it again.
 *
 * Token counts use {@link estimateTokens} (characters / 4), the same estimate
 * every budget in hippo uses. Rows hold counts, surfaces, session ids and
 * hashes, never memory content or query text.
 *
 * DB helpers take the caller's handle; {@link readApiCalls} streams one
 * transcript file. Writes are best-effort at the call sites; a ledger failure
 * must never break recall.
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { DatabaseSyncLike } from './db.js';
import type { JsonObject } from './working-memory.js';
import { type JsonValue, isJsonString } from './json.js';

/**
 * Where a block of memory text was sent.
 * - `hook`: the per-prompt `UserPromptSubmit` hook (`hippo context --pinned-only`).
 * - `hook_recall`: the same hook's prompt-recall section.
 * - `compact_resume`: the snapshot the SessionStart(compact) hook prints (`hippo compact-resume`).
 * - `context`, `recall`: the CLI commands.
 * - `mcp_recall`, `mcp_context`: the MCP tools.
 * - `http_recall`, `http_context`, `http_assemble`: the HTTP API.
 * - `pilot`: the session's pilot arm row (src/pilot-arm.ts); not a send, so it is in no surface list.
 */
export type TokenSurface =
  | 'hook'
  | 'hook_recall'
  | 'compact_resume'
  | 'context'
  | 'recall'
  | 'mcp_recall'
  | 'mcp_context'
  | 'http_recall'
  | 'http_context'
  | 'http_assemble'
  | 'pilot';

/** All surfaces, in report order. */
export const TOKEN_SURFACES: readonly TokenSurface[] = [
  'hook', 'hook_recall', 'compact_resume', 'context', 'recall', 'mcp_recall', 'mcp_context',
  'http_recall', 'http_context', 'http_assemble',
];

/** Surfaces whose re-reads are counted: only a hook payload tells a sub-agent's block from its parent's, as both carry one session id. */
export const REREAD_SURFACES: readonly TokenSurface[] = ['hook', 'hook_recall', 'compact_resume'];

/**
 * What happened to a block.
 * - `inject`: sent to the agent.
 * - `skip`: identical to the session's last injected block, so not sent again.
 * - `reset`: the host compacted its context, so the next block must be sent.
 * - `reread`: tokens later calls read again, booked at session end as one row per session, hook surface and UTC day of the calls.
 * - `arm`: the pilot assignment; `block_hash` is `hippo` or `holdout`, `items` the holdout rate in basis points.
 */
export type TokenEvent = 'inject' | 'skip' | 'reset' | 'reread' | 'arm';

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
  /** Memories (and continuity blocks) in the text; for a `reread`, how many times blocks were read again. */
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
  /** Tokens of these blocks that later model calls read again, from sessions that have ended; 0 off {@link REREAD_SURFACES}. */
  tokensReread: number;
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
  totalTokensReread: number;
  /** Mean tokens sent per session, over rows that carry a session id. */
  meanTokensPerSession: number;
  /** Distinct session ids in the window. */
  sessions: number;
  /** Sessions that sent, skipped or re-read a {@link REREAD_SURFACES} block, the ones whose re-reads can be counted. */
  hookSessions: number;
  /** Sessions whose re-reads were counted at session end; open or crashed sessions are not. */
  rereadSessions: number;
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
            SUM(CASE WHEN event = 'reread' THEN tokens ELSE 0 END) AS reread,
            COUNT(DISTINCT session_id) AS sessions
     FROM token_ledger
     WHERE tenant_id = ? AND ts >= ?
     GROUP BY surface`,
  ).all(tenantId, sinceIso) as Array<{
    surface: string; injected: number; tokens: number; skipped: number; avoided: number; reread: number; sessions: number;
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
      tokensReread: Number(r.reread),
      sessions: Number(r.sessions),
    });
  }
  // SAFETY: the SELECT names exactly these four aggregate columns.
  const perSession = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS sessions,
            COUNT(DISTINCT CASE WHEN event <> 'reset' AND surface IN (${REREAD_SURFACES.map(() => '?').join(', ')}) THEN session_id END) AS hook_sessions,
            COUNT(DISTINCT CASE WHEN event = 'reread' THEN session_id END) AS reread_sessions,
            SUM(CASE WHEN event = 'inject' THEN tokens ELSE 0 END) AS tokens
     FROM token_ledger
     WHERE tenant_id = ? AND ts >= ? AND session_id IS NOT NULL AND event <> 'arm'`,
  ).get(...REREAD_SURFACES, tenantId, sinceIso) as {
    sessions: number; hook_sessions: number; reread_sessions: number; tokens: number | null;
  } | undefined;
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

/** JSON-value string check without a runtime `typeof` (anti-slop rule). */
interface ModelTagged {
  model?: unknown;
}

/** Claude Code writes its own API errors and limit notices as assistant lines from this model; no model call made them. */
export function isSyntheticMessage(message: ModelTagged): boolean {
  return message.model === '<synthetic>';
}

/** JSON-value plain-object check (excludes arrays and null). */
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && !Array.isArray(value) && value.constructor === Object;
}

/** A Claude Code hook payload on stdin as a JSON object; null when empty, malformed or not an object. */
function parseHookPayload(stdinText: string | undefined): JsonObject | null {
  if (!stdinText || stdinText.trim() === '') return null;
  try {
    // SAFETY: JSON.parse returns a JSON value by definition.
    const payload = JSON.parse(stdinText.trim()) as JsonValue;
    return isJsonObject(payload) ? payload : null;
  } catch {
    // Malformed is one of the null cases the docblock names.
    return null;
  }
}

/** A hook payload's non-empty `session_id`, or null; with `requiredSource`, also null when its `source` differs. */
export function hookPayloadSessionId(stdinText: string | undefined, requiredSource: string | null = null): string | null {
  const payload = parseHookPayload(stdinText);
  const sessionId = payload?.session_id;
  if (!payload || !isJsonString(sessionId) || sessionId.trim() === '') return null;
  if (requiredSource !== null && payload.source !== requiredSource) return null;
  return sessionId;
}

/** A hook payload's string `field` as sent, or null when the payload or the field is missing or not a string. */
export function hookPayloadString(stdinText: string | undefined, field: string): string | null {
  const value = parseHookPayload(stdinText)?.[field];
  return isJsonString(value) ? value : null;
}

/** Whether a hook fired inside a sub-agent, the only payload with `agent_id` (https://code.claude.com/docs/en/hooks#common-input-fields).
 *  Its `session_id` is the parent's, so a sub-agent's blocks and compactions must not count as the parent's. */
export function isSubagentPayload(stdinText: string | undefined): boolean {
  const agentId = parseHookPayload(stdinText)?.agent_id;
  return isJsonString(agentId) && agentId.trim() !== '';
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
     WHERE tenant_id = ? AND ts >= ? AND session_id IS NOT NULL AND event <> 'arm'
     GROUP BY session_id`,
  ).all(tenantId, sinceIso) as Array<{ session_id: string; sent: number; skipped: number; injections: number }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    sent: Number(r.sent),
    skipped: Number(r.skipped),
    injections: Number(r.injections),
  }));
}

/** One model API call in a host transcript, for {@link recordRereads}. */
export interface ApiCall {
  /** Epoch milliseconds of the call's first transcript line. */
  at: number;
  /** Compactions before the call, in file order. */
  compactions: number;
}

/** What {@link readApiCalls} found in a transcript. */
export interface TranscriptCalls {
  calls: ApiCall[];
  /** Candidate lines that were not valid JSON, skipped. */
  malformed: number;
}

/** Main-thread model calls in a Claude Code transcript, in file order; rejects when the file cannot be read. */
export async function readApiCalls(transcriptPath: string): Promise<TranscriptCalls> {
  const file = await open(transcriptPath);
  const calls: ApiCall[] = [];
  const seen = new Set<string>();
  let compactions = 0;
  let malformed = 0;
  try {
    for await (const line of file.readLines({ encoding: 'utf8' })) {
      // Transcripts can pass 100 MB, so only lines that can be a call or a boundary are parsed.
      if (!line.includes('"usage"') && !line.includes('"compact_boundary"')) continue;
      let entry: JsonValue;
      try {
        // SAFETY: JSON.parse returns a JSON value by definition.
        entry = JSON.parse(line) as JsonValue;
      } catch {
        malformed += 1; // reported by the caller: one torn line must not void the session
        continue;
      }
      // Sidechain calls, sidechain compactions and `<synthetic>` messages never touch the main context.
      if (!isJsonObject(entry) || entry.isSidechain === true) continue;
      if (entry.subtype === 'compact_boundary') {
        compactions += 1;
        continue;
      }
      // One call spans lines sharing a message id.
      const message = entry.message;
      if (entry.type !== 'assistant' || !isJsonObject(message)) continue;
      if (!isJsonObject(message.usage) || isSyntheticMessage(message) || !isJsonString(message.id)) continue;
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      const at = isJsonString(entry.timestamp) ? Date.parse(entry.timestamp) : Number.NaN;
      if (!Number.isNaN(at)) calls.push({ at, compactions });
    }
  } finally {
    await file.close();
  }
  return { calls, malformed };
}

/** Calls that carried a block sent at `at` (epoch ms): every later call in the first later call's context window. */
export function carryingCalls(calls: readonly ApiCall[], at: number): ApiCall[] {
  // Windows come from file order, not boundary timestamps: the compact-resume block is booked before its boundary's timestamp.
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

/** Replace a session's `reread` rows in one transaction, one per {@link REREAD_SURFACES} surface and UTC day; returns the tokens booked. */
export function recordRereads(db: DatabaseSyncLike, tenantId: string, sessionId: string, calls: readonly ApiCall[]): number {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    // SAFETY: the SELECT names exactly these three columns.
    const rows = db.prepare(
      `SELECT ts, surface, tokens FROM token_ledger
       WHERE tenant_id = ? AND session_id = ? AND event = 'inject' AND surface IN (${REREAD_SURFACES.map(() => '?').join(', ')})`,
    ).all(tenantId, sessionId, ...REREAD_SURFACES) as Array<{ ts: string; surface: TokenSurface; tokens: number }>;
    const days = new Map<string, RereadDay>();
    const add = (surface: TokenSurface, at: number, rereads: number, tokens: number): void => {
      const key = `${surface} ${new Date(at).toISOString().slice(0, 10)}`;
      const day = days.get(key) ?? { surface, at, rereads: 0, tokens: 0 };
      days.set(key, { surface, at: Math.max(day.at, at), rereads: day.rereads + rereads, tokens: day.tokens + tokens });
    };
    for (const row of rows) {
      const sentAt = Date.parse(row.ts);
      // Dated by when the calls happened, so a --days window counts re-reads in it; the empty send-day row keeps the session in coverage.
      add(row.surface, sentAt, 0, 0);
      // The first carrying call is the send itself; every later one is a re-read.
      for (const call of carryingCalls(calls, sentAt).slice(1)) add(row.surface, call.at, 1, Number(row.tokens));
    }
    db.prepare(`DELETE FROM token_ledger WHERE tenant_id = ? AND session_id = ? AND event = 'reread'`).run(tenantId, sessionId);
    for (const day of days.values()) {
      recordTokenUse(db, {
        tenantId, sessionId, surface: day.surface, event: 'reread', items: day.rereads, tokens: day.tokens, now: new Date(day.at).toISOString(),
      });
    }
    db.exec('COMMIT');
    committed = true;
    return [...days.values()].reduce((sum, day) => sum + day.tokens, 0);
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original throw */ }
    }
  }
}
