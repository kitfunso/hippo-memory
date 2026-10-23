// The base store's planning-fallacy read: a claim's tokens resolved to one prediction class, and that class's baserate.
import { computePredictionBaserate } from './predictions.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import type { PlanningFallacyEvidence } from '../port/types.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { resolveClass } from '../rules/class-resolution.js';

/** Resolves a claim's tokens to one class and reads its baserate, writing no audit row. The class tags are
 * TENANT-GLOBAL by design, not scope-filtered (base rates need the full sample): class_tag NAMES can cross scopes; use
 * opaque names or HIPPO_AUTODEBIAS=off. */
export function planningFallacyEvidence(
  db: DatabaseSyncLike,
  tenantId: string,
  classQueryTokens: readonly string[],
): PlanningFallacyEvidence {
  const tags =
    classQueryTokens.length === 0
      ? []
      : (cachedStatement(db, `SELECT DISTINCT class_tag FROM predictions WHERE tenant_id = ?`).all(tenantId) as Array<{
          class_tag: string;
        }>);
  const resolution = resolveClass(
    tags.map((row) => row.class_tag),
    classQueryTokens,
  );
  // emitAudit=false: the recall_autodebias_hint row carries n_closed and mean_ratio, so predict_baserate stays off.
  const baserate = resolution.classTag
    ? computePredictionBaserate(db, tenantId, resolution.classTag, 'recall', false)
    : null;
  return { ...resolution, baserate };
}
