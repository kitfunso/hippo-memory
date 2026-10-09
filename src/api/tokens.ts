// Token-use and failure reports.

import { openHippoDb, closeHippoDb, rethrowIfSqliteBlocked } from '../db.js';
import { summarizeTokenUse, type TokenSummary, type TokenSurface } from '../token-ledger.js';
import { storeFor } from '../store-port.js';
import { summarizeFailures, type FailureSummary } from '../failure-log.js';
import { errorMessage, log } from '../log.js';
import type { Context } from './types.js';
import { DAY_MS } from '../util/time.js';

/**
 * Record memory text handed to an agent in the token ledger.
 * Best-effort: never throws, because a ledger failure must not fail the
 * recall or context call that produced the text.
 */
export async function recordTokens(
  ctx: Context,
  surface: TokenSurface,
  use: { items: number; tokens: number; sessionId?: string | null },
): Promise<void> {
  try {
    await storeFor(ctx).recordTokens({
      tenantId: ctx.tenantId,
      sessionId: use.sessionId ?? null,
      surface,
      event: 'inject',
      items: use.items,
      tokens: use.tokens,
    });
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.warnThenDebug('api-token-ledger', `token ledger write failed; the reply is unaffected: ${errorMessage(err)}`);
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
  return new Date(Date.now() - span * DAY_MS).toISOString();
}
