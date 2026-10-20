// Token-use and failure reports.

import { rethrowIfSqliteBlocked } from '../base/util/sqlite-blocked.js';
import type { TokenSummary, TokenSurface } from '../store/port/token-ledger.js';
import type { FailureSummary } from '../store/port/failure-log.js';
import { errorMessage, log, errorFields } from '../base/util/log.js';
import type { Context } from './types.js';
import { DAY_MS } from '../base/util/time.js';

/** Records memory text handed to an agent in the token ledger. Best-effort: never throws, since a ledger failure must
 * not fail the recall or context call. */
export async function recordTokens(
  ctx: Context,
  surface: TokenSurface,
  use: { items: number; tokens: number; sessionId?: string | null },
): Promise<void> {
  try {
    await ctx.store.recordTokens({
      tenantId: ctx.tenantId,
      sessionId: use.sessionId ?? null,
      surface,
      event: 'inject',
      items: use.items,
      tokens: use.tokens,
    });
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.warnThenDebug(
      'api-token-ledger',
      `token ledger write failed; the reply is unaffected: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

/** Token ledger totals for the tenant over the last `days` days (default 30): tokens sent, skipped as unchanged and
 * re-read, per surface, with session counts and mean tokens per session. */
export function tokenSummary(ctx: Context, opts: { days?: number } = {}): Promise<TokenSummary> {
  return ctx.store.reports.tokenUse(ctx.tenantId, reportWindowStart(opts.days));
}

/** Failed tool calls by outcome, and repeats across sessions, over the last `days` days (default 30). */
export function failureSummary(ctx: Context, opts: { days?: number } = {}): Promise<FailureSummary> {
  return ctx.store.reports.failures(ctx.tenantId, reportWindowStart(opts.days));
}

function reportWindowStart(days: number | undefined): string {
  const span = days !== undefined && Number.isFinite(days) && days > 0 ? days : 30;
  return new Date(Date.now() - span * DAY_MS).toISOString();
}
