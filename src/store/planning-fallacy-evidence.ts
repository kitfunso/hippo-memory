import { onHandle } from './open.js';
import { computePredictionBaserate, type PredictionBaserate } from './predictions.js';

export interface ClassResolution {
  classTag: string | null;
  /** True when >=2 classes tied at the best overlap score AND best >= 1. Caller emits `recall_autodebias_hint_tiebreak` and returns a null hint
   * (silent: an alphabetical tiebreak would show the wrong class half the time). */
  tiebreak: boolean;
}

/** The prediction class a forward claim resolves to, and that class's closed-prediction stats when one resolved. */
export interface PlanningFallacyEvidence extends ClassResolution {
  readonly baserate: PredictionBaserate | null;
}

/** Resolve a query-token set to a unique best-matching class_tag for the tenant: lower-cased token overlap, best score >= 1 AND above the 2nd-best.
 * TENANT-GLOBAL by design, not scope-filtered (base rates need the full sample): class_tag NAMES can cross scopes; use opaque names or HIPPO_AUTODEBIAS=off. */
function resolveClassFromTokens(
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
        // Tie at current best: bump secondBest, do NOT update bestClass (an alphabetical tiebreak would pick the wrong class on ambiguous queries; stay silent
        // on tie).
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
