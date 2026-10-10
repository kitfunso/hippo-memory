import { onHandle } from './open.js';
import { computePredictionBaserate, type PredictionBaserate } from './predictions.js';

export interface ClassResolution {
  classTag: string | null;
  /** True when ≥2 classes tied at the best overlap score AND best ≥ 1.
   *  Caller emits `recall_autodebias_hint_tiebreak` audit and returns
   *  null hint (silent — prevents the "show wrong class half the time"
   *  failure mode the alphabetical-tiebreak alternative would create). */
  tiebreak: boolean;
}

/** The prediction class a forward claim resolves to, and that class's closed-prediction stats when one resolved. */
export interface PlanningFallacyEvidence extends ClassResolution {
  readonly baserate: PredictionBaserate | null;
}

/**
 * Resolve a query-token set to a unique best-matching class_tag for the
 * tenant. Scores by lower-cased token overlap; requires best score ≥ 1
 * AND strictly greater than the 2nd-best score.
 *
 * Indexed via idx_predictions_tenant_class (db.ts:1015) → O(log n) seek
 * plus a small DISTINCT scan over the per-tenant class-tag set.
 *
 * Scope behaviour (deliberate): class_tag selection is TENANT-GLOBAL,
 * NOT scope-filtered against
 * the recall's opts.scope. The class_tag is an aggregator label across
 * historical predictions in the class, not a per-memory scope-bound
 * property. A no-scope recall CAN surface a class_tag from a privately-
 * scoped prediction's class in PlanningFallacyHint.classTag — by design,
 * because base-rate reasoning needs the full historical sample.
 * Implications:
 *   - The hint payload itself carries no memory content (only the aggregate
 *     summary string + numeric stats), so memory bodies do not leak.
 *   - The class_tag NAME is the side-channel. If sensitive labels are a
 *     concern, callers should either use opaque class names (e.g. hashes
 *     or numeric tokens) or set HIPPO_AUTODEBIAS=off.
 *   - tests/api-recall-autodebias.test.ts locks this with an explicit
 *     test asserting that scope-set predictions surface via no-scope
 *     recalls (so future "fix" attempts that scope-filter trip CI).
 */
export function resolveClassFromTokens(
  hippoRoot: string,
  tenantId: string,
  queryTokens: readonly string[],
): ClassResolution {
  if (queryTokens.length === 0) return { classTag: null, tiebreak: false };
  return onHandle(hippoRoot, (db) => {
    // SAFETY: rows' shape matches the single `class_tag` column named in the SELECT above.
    const rows = db.prepare(
      `SELECT DISTINCT class_tag FROM predictions WHERE tenant_id = ?`,
    ).all(tenantId) as Array<{ class_tag: string }>;

    const querySet = new Set(queryTokens);
    let bestScore = 0;
    let bestClass: string | null = null;
    let secondBest = 0;
    for (const { class_tag } of rows) {
      const classTokens = class_tag
        .toLowerCase()
        .split(/[-_\s]+/)
        .filter((t) => t.length >= 3);
      let score = 0;
      for (const t of classTokens) if (querySet.has(t)) score++;
      if (score > bestScore) {
        secondBest = bestScore;
        bestScore = score;
        bestClass = class_tag;
      } else if (score === bestScore && score > 0) {
        // Tie at current best — bump secondBest. Do NOT update bestClass
        // (alphabetical tiebreak would pick wrong class on ambiguous query
        // like "migration will take 3 days" between migration-effort vs
        // migration-risk; silent on tie instead).
        secondBest = score;
      } else if (score > secondBest) {
        secondBest = score;
      }
    }
    if (bestScore < 1) return { classTag: null, tiebreak: false };
    if (bestScore === secondBest) return { classTag: null, tiebreak: true };
    return { classTag: bestClass, tiebreak: false };
  });
}

/** Resolves a claim's tokens to one class and reads its baserate, writing no audit row. */
export function planningFallacyEvidenceAt(hippoRoot: string, tenantId: string, classQueryTokens: readonly string[]): PlanningFallacyEvidence {
  const resolution = resolveClassFromTokens(hippoRoot, tenantId, classQueryTokens);
  // emitAudit=false: the recall_autodebias_hint row carries n_closed and mean_ratio, so predict_baserate stays off.
  const baserate = resolution.classTag ? computePredictionBaserate(hippoRoot, tenantId, resolution.classTag, 'recall', false) : null;
  return { ...resolution, baserate };
}
