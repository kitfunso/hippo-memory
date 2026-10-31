// Token-use and failure reports, which hippo.db's local tier answers in SQL.

import type { TokenSummary } from '../../base/records/ledger.js';
import type { FailureSummary } from '../../base/records/rejections.js';
import { DAY_MS } from '../../base/util/time.js';
import type { HippoDbContext } from '../hippo-db-context.js';

/** Days a token or failure report covers when the caller names none. */
export const DEFAULT_REPORT_WINDOW_DAYS = 30;

/** Token ledger totals for the tenant over the last `days` days (default
 * DEFAULT_REPORT_WINDOW_DAYS): tokens sent, skipped as unchanged and re-read, per surface, with
 * session counts and mean tokens per session. */
export function tokenSummary(
  ctx: HippoDbContext,
  opts: { days?: number } = {},
): Promise<TokenSummary> {
  return ctx.store.hippoDb.reports.tokenUse(
    ctx.tenantId,
    reportWindowStart(opts.days, ctx.infra.clock()),
  );
}

/** Failed tool calls by outcome, and repeats across sessions, over the last `days` days (default
 * DEFAULT_REPORT_WINDOW_DAYS). */
export function failureSummary(
  ctx: HippoDbContext,
  opts: { days?: number } = {},
): Promise<FailureSummary> {
  return ctx.store.hippoDb.reports.failures(
    ctx.tenantId,
    reportWindowStart(opts.days, ctx.infra.clock()),
  );
}

function reportWindowStart(days: number | undefined, now: Date): string {
  const span =
    days !== undefined && Number.isFinite(days) && days > 0 ? days : DEFAULT_REPORT_WINDOW_DAYS;
  return new Date(now.getTime() - span * DAY_MS).toISOString();
}
