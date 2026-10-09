// A store that answers only through the port: serve() blocks hippo.db for any other kind, so a recall
// path that still opens hippo.db directly throws, while the port's own methods reach the same rows.
import { withSqliteAllowed } from '../../src/db.js';
import { sqliteStore, type HippoStore, type VectorReads } from '../../src/store-port.js';

function allowed<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => withSqliteAllowed(() => fn(...args));
}

/** The required methods only, as an add-on built before the vector reads has them. Each is listed by hand so a method added to the port fails to compile here until it is wired. */
export function portOnlyStoreWithoutVectorReads(hippoRoot: string): HippoStore {
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
    finishRecall: allowed(inner.finishRecall),
    bumpRecallStats: allowed(inner.bumpRecallStats),
    recordTokens: allowed(inner.recordTokens),
    close: allowed(inner.close),
  };
}

export function portOnlyStore(hippoRoot: string): HippoStore & { readonly vectors: VectorReads } {
  const { vectors } = sqliteStore(hippoRoot);
  return {
    ...portOnlyStoreWithoutVectorReads(hippoRoot),
    vectors: {
      embeddingIndexState: allowed(vectors.embeddingIndexState),
      storedVectors: allowed(vectors.storedVectors),
      nearestEntries: allowed(vectors.nearestEntries),
      physicsParticles: allowed(vectors.physicsParticles),
    },
  };
}
