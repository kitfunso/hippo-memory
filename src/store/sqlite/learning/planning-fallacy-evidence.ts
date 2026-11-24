import { computePredictionBaserate } from './prediction-baserate.js';
import type { DatabaseSyncLike } from '../../../db/index.js';
import type { PlanningFallacyEvidence, ClassResolution } from '../../../base/ports/store/types.js';
import { cachedStatement } from '../../../db/statement-cache.js';

function resolveClass(
  classTags: Iterable<string>,
  queryTokens: readonly string[],
): ClassResolution {
  if (queryTokens.length === 0) return { classTag: null, tiebreak: false };
  const query = new Set(queryTokens);
  let best = 0;
  let second = 0;
  let bestClass: string | null = null;
  for (const tag of classTags) {
    const parts = tag
      .toLowerCase()
      .split(/[-_\s]+/)
      .filter((part) => part.length >= 3);
    const score = parts.filter((part) => query.has(part)).length;
    if (score > best) {
      second = best;
      best = score;
      bestClass = tag;
    } else if ((score === best && score > 0) || score > second) {
      second = score;
    }
  }
  if (best < 1) return { classTag: null, tiebreak: false };
  if (best === second) return { classTag: null, tiebreak: true };
  return { classTag: bestClass, tiebreak: false };
}

/** Resolves a claim's tokens to one class and reads its baserate, writing no audit row. The
 * class tags are TENANT-GLOBAL by design, not scope-filtered (base rates need the full sample):
 * class_tag NAMES can cross scopes; use opaque names or HIPPO_AUTODEBIAS=off. */
export function planningFallacyEvidence(
  db: DatabaseSyncLike,
  tenantId: string,
  classQueryTokens: readonly string[],
): PlanningFallacyEvidence {
  const tags =
    classQueryTokens.length === 0
      ? []
      : (cachedStatement(db, `SELECT DISTINCT class_tag FROM predictions WHERE tenant_id = ?`).all(
          tenantId,
        ) as Array<{
          class_tag: string;
        }>);
  const resolution = resolveClass(
    tags.map((row) => row.class_tag),
    classQueryTokens,
  );
  const baserate = resolution.classTag
    ? computePredictionBaserate(db, tenantId, resolution.classTag, 'recall', false)
    : null;
  return { ...resolution, baserate };
}
