// SQL for the token_ledger table in the ledger database; callers keep the handle, the transaction and the arithmetic.
import type { DatabaseSyncLike } from '../../db/index.js';
import type { TokenSurface } from '../port/token-ledger.js';
import { placeholders } from '../../base/util/sql.js';
import type { TenantId } from '../../base/util/tenant.js';
import { tenantAnd } from './tenant.js';

export interface TokenRowInput {
  ts: string;
  tenantId: string;
  sessionId: string | null;
  surface: string;
  event: string;
  items: number;
  tokens: number;
  blockHash: string | null;
}

export function insertTokenRow(db: DatabaseSyncLike, row: TokenRowInput): void {
  db.prepare(
    `INSERT INTO token_ledger (ts, tenant_id, session_id, surface, event, items, tokens, block_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.ts, row.tenantId, row.sessionId, row.surface, row.event, row.items, row.tokens, row.blockHash);
}

export function pruneTokenRowsBefore(db: DatabaseSyncLike, cutoffIso: string): void {
  db.prepare(`DELETE FROM token_ledger WHERE ts < ?`).run(cutoffIso);
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
export interface LedgerAnchor {
  id: number;
  event: string;
  block_hash: string | null;
}

/** The session's newest inject or reset row on a surface. */
export function latestInjectOrReset(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  surface: string,
): LedgerAnchor | undefined {
  return db
    .prepare(
      `SELECT id, event, block_hash FROM token_ledger
     WHERE tenant_id = ? AND session_id = ? AND surface = ? AND event IN ('inject', 'reset')
     ORDER BY id DESC LIMIT 1`,
    )
    .get(tenantId, sessionId, surface) as LedgerAnchor | undefined;
}

export function countSkipsAfter(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  surface: string,
  afterId: number,
): { n: number } | undefined {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM token_ledger
     WHERE tenant_id = ? AND session_id = ? AND surface = ? AND event = 'skip' AND id > ?`,
    )
    .get(tenantId, sessionId, surface, afterId) as { n: number } | undefined;
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
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
  return db
    .prepare(
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
    )
    .all(tenantId, sinceIso) as SurfaceTotalsRow[];
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
export interface SessionTotalsRow {
  sessions: number;
  hook_sessions: number;
  reread_sessions: number;
  tokens: number | null;
}

/** Window-wide session counts; `rereadSurfaces` are the hook surfaces whose sessions count as hook sessions. */
export function sessionTotals(
  db: DatabaseSyncLike,
  tenantId: string,
  sinceIso: string,
  rereadSurfaces: readonly TokenSurface[],
): SessionTotalsRow | undefined {
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

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
export interface SessionTokenRow {
  session_id: string;
  sent: number;
  skipped: number;
  injections: number;
}

export function sessionTokenRows(db: DatabaseSyncLike, tenantId: string, sinceIso: string): SessionTokenRow[] {
  return db
    .prepare(
      `SELECT session_id,
            SUM(CASE WHEN event = 'inject' THEN tokens ELSE 0 END) AS sent,
            SUM(CASE WHEN event = 'skip' THEN tokens ELSE 0 END) AS skipped,
            SUM(CASE WHEN event = 'inject' THEN 1 ELSE 0 END) AS injections
     FROM token_ledger
     WHERE tenant_id = ? AND ts >= ? AND session_id IS NOT NULL AND event <> 'arm'
     GROUP BY session_id`,
    )
    .all(tenantId, sinceIso) as SessionTokenRow[];
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
export interface InjectedBlockRow {
  ts: string;
  surface: TokenSurface;
  tokens: number;
}

export function injectedBlocks(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  surfaces: readonly TokenSurface[],
): InjectedBlockRow[] {
  return db
    .prepare(
      `SELECT ts, surface, tokens FROM token_ledger
     WHERE tenant_id = ? AND session_id = ? AND event = 'inject' AND surface IN (${placeholders(surfaces.length)})`,
    )
    .all(tenantId, sessionId, ...surfaces) as InjectedBlockRow[];
}

export function deleteRereadRows(db: DatabaseSyncLike, tenantId: string, sessionId: string): void {
  db.prepare(`DELETE FROM token_ledger WHERE tenant_id = ? AND session_id = ? AND event = 'reread'`).run(
    tenantId,
    sessionId,
  );
}

/** The first stored pilot arm hash for a session in `tenantId`. */
export function firstPilotArmHash(
  db: DatabaseSyncLike,
  sessionId: string,
  tenantId: TenantId,
): { block_hash: string | null } | undefined {
  const tenant = tenantAnd(tenantId);
  return db
    .prepare(
      `SELECT block_hash FROM token_ledger WHERE session_id = ?${tenant.sql}
     AND surface = 'pilot' AND event = 'arm' ORDER BY id LIMIT 1`,
    )
    .get(sessionId, ...tenant.args) as { block_hash: string | null } | undefined;
}
