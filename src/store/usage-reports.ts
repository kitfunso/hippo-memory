// The token-use and failure reports, each read on one handle of its own.
// A file apart from token-ledger-rows.ts: src/store/token-ledger.ts imports that one, so a summary there would be an
// import cycle.

import type { DatabaseSyncLike } from '../db/index.js';
import { summarizeTokenUse } from './token-ledger.js';
import type { TokenSummary } from './port/token-ledger.js';
import { summarizeFailures } from './failure-log.js';
import type { FailureSummary } from './port/failure-log.js';

/** One tenant's token ledger totals since `sinceIso`. */
export function tokenUseSummaryAt(db: DatabaseSyncLike, tenantId: string, sinceIso: string): TokenSummary {
  return summarizeTokenUse(db, tenantId, sinceIso);
}

/** One tenant's failure log totals since `sinceIso`. */
export function failureLogSummaryAt(db: DatabaseSyncLike, tenantId: string, sinceIso: string): FailureSummary {
  return summarizeFailures(db, tenantId, sinceIso);
}
