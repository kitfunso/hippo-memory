// The token-use and failure reports, each read on one handle of its own.
// A file apart from token-ledger-rows.ts: src/store/token-ledger.ts imports that one, so a summary there would be an import cycle.

import { closeHippoDb, openHippoDb } from '../db/index.js';
import { summarizeTokenUse, type TokenSummary } from './token-ledger.js';
import { summarizeFailures, type FailureSummary } from './failure-log.js';

/** One tenant's token ledger totals since `sinceIso`. */
export function tokenUseSummary(hippoRoot: string, tenantId: string, sinceIso: string): TokenSummary {
  const db = openHippoDb(hippoRoot);
  try {
    return summarizeTokenUse(db, tenantId, sinceIso);
  } finally {
    closeHippoDb(db);
  }
}

/** One tenant's failure log totals since `sinceIso`. */
export function failureLogSummary(hippoRoot: string, tenantId: string, sinceIso: string): FailureSummary {
  const db = openHippoDb(hippoRoot);
  try {
    return summarizeFailures(db, tenantId, sinceIso);
  } finally {
    closeHippoDb(db);
  }
}
