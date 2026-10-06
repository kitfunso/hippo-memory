// A store that answers only through the port: serve() blocks hippo.db for any other kind, so a recall
// path that still opens hippo.db directly throws, while the port's own methods reach the same rows.
import { withSqliteAllowed } from '../../src/db.js';
import { sqliteStore, type HippoStore } from '../../src/store-port.js';

function allowed<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => withSqliteAllowed(() => fn(...args));
}

/** Every method is listed by hand so a method added to the port fails to compile here until it is wired. */
export function portOnlyStore(hippoRoot: string): HippoStore {
  const inner = sqliteStore(hippoRoot);
  return {
    kind: 'port-only',
    findApiKey: allowed(inner.findApiKey),
    searchRecallEntries: allowed(inner.searchRecallEntries),
    entriesByIds: allowed(inner.entriesByIds),
    activeGoals: allowed(inner.activeGoals),
    freshRawEntries: allowed(inner.freshRawEntries),
    continuity: allowed(inner.continuity),
    planningFallacyEvidence: allowed(inner.planningFallacyEvidence),
    appendAuditEvents: allowed(inner.appendAuditEvents),
    writeRecallTrace: allowed(inner.writeRecallTrace),
    strengthenRetrieved: allowed(inner.strengthenRetrieved),
    logGoalRecall: allowed(inner.logGoalRecall),
    bumpRecallStats: allowed(inner.bumpRecallStats),
    recordTokens: allowed(inner.recordTokens),
    close: allowed(inner.close),
  };
}
