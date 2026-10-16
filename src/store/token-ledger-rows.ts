// SQL for the token_ledger table in the ledger database; callers keep the handle, the transaction and the arithmetic.
import type { DatabaseSyncLike } from '../db/index.js';
import type { TokenSurface } from './token-ledger.js';
import { placeholders } from '../util/sql.js';

export interface TokenRowInput {
  ts: string;
  tenantId: string;
  sessionId: string | null;
  surface: string;
  event: string;
  items: number;
  tokens: number;
  blockHash: string | null;
  /** JSON text: a key array once printed, `{"pending":[...]}` until the caller echoes the block hash. */
  sentKeys: string | null;
}

export function insertTokenRow(db: DatabaseSyncLike, row: TokenRowInput): void {
  db.prepare(
    `INSERT INTO token_ledger (ts, tenant_id, session_id, surface, event, items, tokens, block_hash, sent_keys)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.ts, row.tenantId, row.sessionId, row.surface, row.event, row.items, row.tokens, row.blockHash, row.sentKeys,
  );
}

export interface WindowRow {
  id: number;
  sent_keys: string;
}

/** The session's rows carrying sent keys on a surface after its latest reset, oldest first. */
export function windowRows(db: DatabaseSyncLike, tenantId: string, sessionId: string, surface: string): WindowRow[] {
  // SAFETY: the SELECT names exactly these two columns, sent_keys NOT NULL by the WHERE.
  return db.prepare(
    `SELECT id, sent_keys FROM token_ledger
     WHERE tenant_id = ? AND session_id = ? AND surface = ? AND sent_keys IS NOT NULL
       AND id > COALESCE((SELECT MAX(id) FROM token_ledger
                          WHERE tenant_id = ? AND session_id = ? AND surface = ? AND event = 'reset'), 0)
     ORDER BY id`,
  ).all(tenantId, sessionId, surface, tenantId, sessionId, surface) as WindowRow[];
}

/** Turns the newest pending row whose block hash the caller echoed into a printed one; true when a row changed. */
export function commitPendingRow(
  db: DatabaseSyncLike, tenantId: string, sessionId: string, surface: string, blockHash: string,
): boolean {
  const res = db.prepare(
    `UPDATE token_ledger SET sent_keys = json_extract(sent_keys, '$.pending')
     WHERE id = (SELECT id FROM token_ledger
                 WHERE tenant_id = ? AND session_id = ? AND surface = ? AND block_hash = ?
                   AND json_valid(sent_keys) AND json_type(sent_keys, '$.pending') = 'array'
                 ORDER BY id DESC LIMIT 1)`,
  ).run(tenantId, sessionId, surface, blockHash);
  return Number(res.changes ?? 0) > 0;
}

export function pruneTokenRowsBefore(db: DatabaseSyncLike, cutoffIso: string): void {
  db.prepare(`DELETE FROM token_ledger WHERE ts < ?`).run(cutoffIso);
}

export interface SurfaceTotalsRow {
  surface: string;
  injected: number;
  tokens: number;
  skipped: number;
  avoided: number;
  reread: number;
  sessions: number;
}

export function surfaceTotals(db: DatabaseSyncLike, tenantId: string, sinceIso: string): SurfaceTotalsRow[] {
  // SAFETY: the SELECT names exactly these columns, all aggregates or TEXT.
  return db.prepare(
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
  ).all(tenantId, sinceIso) as SurfaceTotalsRow[];
}

export interface SessionTotalsRow {
  sessions: number;
  hook_sessions: number;
  reread_sessions: number;
  tokens: number | null;
}

/** Window-wide session counts; `rereadSurfaces` are the hook surfaces whose sessions count as hook sessions. */
export function sessionTotals(
  db: DatabaseSyncLike, tenantId: string, sinceIso: string, rereadSurfaces: readonly TokenSurface[],
): SessionTotalsRow | undefined {
  // SAFETY: the SELECT names exactly these four aggregate columns.
  return db
    .prepare(
      `SELECT COUNT(DISTINCT session_id) AS sessions,
            COUNT(DISTINCT CASE WHEN event <> 'reset' AND surface IN (${placeholders(rereadSurfaces.length)}) THEN
            session_id END) AS hook_sessions,
            COUNT(DISTINCT CASE WHEN event = 'reread' THEN session_id END) AS reread_sessions,
            SUM(CASE WHEN event = 'inject' THEN tokens ELSE 0 END) AS tokens
     FROM token_ledger
     WHERE tenant_id = ? AND ts >= ? AND session_id IS NOT NULL AND event <> 'arm'`,
    )
    .get(...rereadSurfaces, tenantId, sinceIso) as SessionTotalsRow | undefined;
}

export interface SessionTokenRow {
  session_id: string;
  sent: number;
  skipped: number;
  injections: number;
}

export function sessionTokenRows(db: DatabaseSyncLike, tenantId: string, sinceIso: string): SessionTokenRow[] {
  // SAFETY: the SELECT names exactly these columns, all aggregates or TEXT.
  return db.prepare(
    `SELECT session_id,
            SUM(CASE WHEN event = 'inject' THEN tokens ELSE 0 END) AS sent,
            SUM(CASE WHEN event = 'skip' THEN tokens ELSE 0 END) AS skipped,
            SUM(CASE WHEN event = 'inject' THEN 1 ELSE 0 END) AS injections
     FROM token_ledger
     WHERE tenant_id = ? AND ts >= ? AND session_id IS NOT NULL AND event <> 'arm'
     GROUP BY session_id`,
  ).all(tenantId, sinceIso) as SessionTokenRow[];
}

export interface InjectedBlockRow {
  ts: string;
  surface: TokenSurface;
  tokens: number;
}

export function injectedBlocks(
  db: DatabaseSyncLike, tenantId: string, sessionId: string, surfaces: readonly TokenSurface[],
): InjectedBlockRow[] {
  // SAFETY: the SELECT names exactly these three columns.
  return db.prepare(
    `SELECT ts, surface, tokens FROM token_ledger
     WHERE tenant_id = ? AND session_id = ? AND event = 'inject' AND surface IN (${placeholders(surfaces.length)})`,
  ).all(tenantId, sessionId, ...surfaces) as InjectedBlockRow[];
}

export function deleteRereadRows(db: DatabaseSyncLike, tenantId: string, sessionId: string): void {
  db.prepare(`DELETE FROM token_ledger WHERE tenant_id = ? AND session_id = ? AND event = 'reread'`).run(
    tenantId,
    sessionId,
  );
}

/** The first stored pilot arm hash for a session, optionally of one tenant. */
export function firstPilotArmHash(
  db: DatabaseSyncLike, sessionId: string, tenantId?: string,
): { block_hash: string | null } | undefined {
  const params = tenantId === undefined ? [sessionId] : [sessionId, tenantId];
  // SAFETY: the SELECT names exactly this one column.
  return db.prepare(
    `SELECT block_hash FROM token_ledger WHERE session_id = ?${tenantId === undefined ? '' : ' AND tenant_id = ?'}
     AND surface = 'pilot' AND event = 'arm' ORDER BY id LIMIT 1`,
  ).get(...params) as { block_hash: string | null } | undefined;
}
