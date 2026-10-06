// Token-use and failure reports.

import { openHippoDb, closeHippoDb, rethrowIfSqliteBlocked } from '../db.js';
import { recordTokenUse, summarizeTokenUse, type TokenSummary, type TokenSurface } from '../token-ledger.js';
import { summarizeFailures, type FailureSummary } from '../failure-log.js';
import { log } from '../log.js';
import type { Context } from './types.js';

/**
 * Record memory text handed to an agent in the token ledger.
 * Best-effort: never throws, because a ledger failure must not fail the
 * recall or context call that produced the text.
 */
export function recordTokens(
  ctx: Context,
  surface: TokenSurface,
  use: { items: number; tokens: number; sessionId?: string | null },
): void {
  try {
    const db = openHippoDb(ctx.hippoRoot);
    try {
      recordTokenUse(db, {
        tenantId: ctx.tenantId,
        sessionId: use.sessionId ?? null,
        surface,
        event: 'inject',
        items: use.items,
        tokens: use.tokens,
      });
    } finally {
      closeHippoDb(db);
    }
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.warnThenDebug('api-token-ledger', `token ledger write failed; the reply is unaffected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Token ledger totals for the tenant over the last `days` days (default 30):
 * tokens sent, skipped as unchanged and re-read by later model calls, per
 * surface, with session counts and mean tokens per session.
 */
export function tokenSummary(ctx: Context, opts: { days?: number } = {}): TokenSummary {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    return summarizeTokenUse(db, ctx.tenantId, reportWindowStart(opts.days));
  } finally {
    closeHippoDb(db);
  }
}

/** Failed tool calls by outcome, and repeats across sessions, over the last `days` days (default 30). */
export function failureSummary(ctx: Context, opts: { days?: number } = {}): FailureSummary {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    return summarizeFailures(db, ctx.tenantId, reportWindowStart(opts.days));
  } finally {
    closeHippoDb(db);
  }
}

function reportWindowStart(days: number | undefined): string {
  const span = days !== undefined && Number.isFinite(days) && days > 0 ? days : 30;
  return new Date(Date.now() - span * 86_400_000).toISOString();
}
