// The status tally, once for both adapters: each row scored by calculateStrength and confidenceFacets, summed in the
// order given so the average rounds the same under either store.
import {
  calculateStrength,
  confidenceFacets,
  Layer,
  type ConfidenceInputs,
  type LossAversion,
  type StrengthInputs,
} from '../../base/memory/memory.js';
import type { StatusCounts } from '../port/reports.js';

/** What one row's status reads: its strength and confidence inputs and its layer. */
export type StatusInputs = StrengthInputs & ConfidenceInputs & { readonly layer: Layer };

/** The counts over `rows`; the caller adds the conflict and vector counts. */
export function tallyStatus(
  rows: Iterable<StatusInputs>,
  now: Date,
  atRiskBelow: number,
  rules: LossAversion,
): Omit<StatusCounts, 'openConflicts' | 'embedded'> {
  const byLayer = { [Layer.Buffer]: 0, [Layer.Episodic]: 0, [Layer.Semantic]: 0, [Layer.Trace]: 0 };
  const byConfidence = { verified: 0, observed: 0, inferred: 0, stale: 0 };
  const sums = { total: 0, strength: 0, pinned: 0, atRisk: 0, agedOut: 0 };
  for (const row of rows) {
    const strength = calculateStrength(row, now, rules);
    const facets = confidenceFacets(row, now);
    sums.total++;
    sums.strength += strength;
    byLayer[row.layer] = (byLayer[row.layer] ?? 0) + 1;
    byConfidence[facets.tier] = (byConfidence[facets.tier] ?? 0) + 1;
    if (row.pinned) sums.pinned++;
    if (strength < atRiskBelow) sums.atRisk++;
    if (facets.agedOut) sums.agedOut++;
  }
  const { total, pinned, atRisk, agedOut } = sums;
  return { total, byLayer, byConfidence, pinned, atRisk, agedOut, avgStrength: total > 0 ? sums.strength / total : 0 };
}
