/** Learned memory-value scorer, a rescue-only veto in the sleep decay pass (it can only shrink the condemned set); mirrors benchmarks/memory-value/*.mjs.
 * rescueSet rescues a condemned entry iff it ranks in the top 30% (RESCUE_BUDGET) of its tenant's non-pinned set; memory-value-wiring.test.ts guards parity. */

import { DEFAULT_TENANT_ID } from '../util/env.js';
import { type MemoryEntry, calculateStrength } from '../core/memory.js';
import { compareEntryIdentity } from '../core/compare.js';
import { MEMORY_VALUE_WEIGHTS, SOURCE_ARTIFACT_SHA256 } from './memory-value-weights.js';
import { DAY_MS } from '../util/time.js';

/** The 8 live feature dims (FIT_DIMS) — canonical order for iteration. */
export const MV_FEATURE_NAMES: ReadonlyArray<keyof MvFeatureVector> = [
  'age_days',
  'half_life_days',
  'strength',
  'retrieval_count',
  'outcome_positive',
  'outcome_negative',
  'outcome_ratio',
  'content_length',
];

/** The keep-budget operating point (the only point with measured
 *  evidence): a code constant tied to that evidence, not user-tunable. */
const RESCUE_BUDGET = 0.3;

/** Per-tenant floor on the non-pinned candidate set: below it ranks are noise, and keepN=ceil(0.3*N) would rescue a 1-entry tenant's entry every sleep forever.
 * A code constant tied to that reasoning, not user-tunable (like RESCUE_BUDGET). */
const MIN_RESCUE_GROUP = 10;

export interface MvFeatureVector {
  age_days: number;
  half_life_days: number;
  strength: number;
  retrieval_count: number;
  outcome_positive: number;
  outcome_negative: number;
  outcome_ratio: number;
  content_length: number;
}

/** Blind v1 feature dict for one entry, restricted to the 8 dims the frozen weights carry. `strength` is CLOCK-BASIS `calculateStrength(entry, now)` with no
 * DecayOptions, as in the weights' training; passing the production decay basis would silently break parity with the frozen weights. */
export function computeMvFeatures(entry: MemoryEntry, now: Date): MvFeatureVector {
  const ageDays = (now.getTime() - Date.parse(entry.created)) / DAY_MS;
  const pos = entry.outcome_positive ?? 0;
  const neg = entry.outcome_negative ?? 0;
  return {
    age_days: ageDays,
    half_life_days: entry.half_life_days,
    strength: calculateStrength(entry, now), // clock-basis, never decayOpts — see doc comment above
    retrieval_count: entry.retrieval_count,
    outcome_positive: pos,
    outcome_negative: neg,
    outcome_ratio: (pos - neg) / (pos + neg + 1), // same formula as extract.mjs / calculateRewardFactor's ratio term
    content_length: entry.content.length,
  };
}

/** Throws on a malformed weight constant (wrong dims, non-finite weight, missing digest): flag-on with a broken constant must throw, never act as flag-off.
 * Parameterized (default: the frozen singleton) so the throw paths are unit-testable. */
function isFiniteWeightValue(value: number): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyDigestString(value: string): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validateWeights(
  weights: Readonly<Record<string, number>> = MEMORY_VALUE_WEIGHTS,
  digest: string = SOURCE_ARTIFACT_SHA256,
): void {
  for (const key of MV_FEATURE_NAMES) {
    const v = weights[key];
    if (!isFiniteWeightValue(v)) {
      throw new Error(
        `memory-value: weights constant is malformed — "${key}" is not a finite number ` +
        `(src/consolidate/memory-value-weights.ts)`,
      );
    }
  }
  if (!isNonEmptyDigestString(digest)) {
    throw new Error(
      'memory-value: weights constant is malformed — SOURCE_ARTIFACT_SHA256 digest missing (src/consolidate/memory-value-weights.ts)',
    );
  }
}

/** Min-max normalize the 8 features over the given entries (constant -> 0), then score = dot(weights, normalized); callers set the scope.
 * An entry with any non-finite feature (NaN from a malformed `created`) is excluded from normalization and scores -Infinity, so it can never be rescued. */
export function scoreEntries(
  entries: MemoryEntry[],
  now: Date,
  weights: Readonly<Record<string, number>> = MEMORY_VALUE_WEIGHTS,
): Map<string, number> {
  const raw = new Map<string, MvFeatureVector>();
  for (const e of entries) raw.set(e.id, computeMvFeatures(e, now));

  const nonFiniteIds = new Set<string>();
  for (const e of entries) {
    const nf = raw.get(e.id)!;
    if (MV_FEATURE_NAMES.some((f) => !Number.isFinite(nf[f]))) nonFiniteIds.add(e.id);
  }
  const normContextEntries = entries.filter((e) => !nonFiniteIds.has(e.id));

  const minMax = new Map<keyof MvFeatureVector, { min: number; max: number }>();
  for (const f of MV_FEATURE_NAMES) {
    let min = Infinity;
    let max = -Infinity;
    for (const e of normContextEntries) {
      const v = raw.get(e.id)![f];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    minMax.set(f, { min, max });
  }
  const norm = (f: keyof MvFeatureVector, v: number): number => {
    const { min, max } = minMax.get(f)!;
    return max === min ? 0 : (v - min) / (max - min);
  };

  const scores = new Map<string, number>();
  for (const e of entries) {
    if (nonFiniteIds.has(e.id)) {
      scores.set(e.id, -Infinity);
      continue;
    }
    const nf = raw.get(e.id)!;
    let sum = 0;
    for (const f of MV_FEATURE_NAMES) sum += weights[f] * norm(f, nf[f]);
    scores.set(e.id, sum);
  }
  return scores;
}

/** Per-entry rank context within its tenant's non-pinned candidate set: the basis both rescueSet and the consolidate audit-row metadata read. */
export interface MvRankInfo {
  tenantId: string;
  score: number;
  /** 1-based rank by score DESC within the tenant's non-pinned candidate set. */
  rank: number;
  /** Size of the tenant's non-pinned candidate set. */
  totalNonPinned: number;
  /** ceil(RESCUE_BUDGET * totalNonPinned) — the rescue cutoff; rank <= keepN rescues. */
  keepN: number;
}

/** Group non-pinned entries by tenantId, score and rank each group independently, and return rank context for every non-pinned entry;
 * rescueSet and the consolidate audit rows share it so they never compute the ranking differently. */
export function rankNonPinnedByTenant(
  entries: MemoryEntry[],
  now: Date,
  weights: Readonly<Record<string, number>> = MEMORY_VALUE_WEIGHTS,
  digest: string = SOURCE_ARTIFACT_SHA256,
): Map<string, MvRankInfo> {
  validateWeights(weights, digest);

  const byTenant = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    if (e.pinned) continue; // pinned entries never compete for rescue (never condemned)
    // Default an undefined tenantId as dag.ts:341 does: a raw/legacy row can carry one at runtime,
    // and keying it "undefined" would split it into its own singleton tenant.
    const tenantId = e.tenantId ?? DEFAULT_TENANT_ID;
    const list = byTenant.get(tenantId);
    if (list) list.push(e);
    else byTenant.set(tenantId, [e]);
  }

  const result = new Map<string, MvRankInfo>();
  for (const [tenantId, group] of byTenant) {
    const scores = scoreEntries(group, now, weights);
    // score DESC, then compareEntryIdentity, the shared tie-break of every score-primary sort (src/core/compare.ts).
    // `-Infinity - -Infinity` is NaN, which Array.sort leaves insertion-order-dependent, so NaN ties too.
    const sorted = [...group].sort((a, b) => {
      const diff = scores.get(b.id)! - scores.get(a.id)!;
      return diff === 0 || Number.isNaN(diff) ? compareEntryIdentity(a, b) : diff;
    });
    // Tenants smaller than MIN_RESCUE_GROUP never rescue (keepN 0); see that constant's doc comment.
    const keepN = sorted.length < MIN_RESCUE_GROUP
      ? 0
      : Math.min(sorted.length, Math.ceil(RESCUE_BUDGET * sorted.length));
    sorted.forEach((e, i) => {
      result.set(e.id, {
        tenantId,
        score: scores.get(e.id)!,
        rank: i + 1,
        totalNonPinned: sorted.length,
        keepN,
      });
    });
  }
  return result;
}

export interface RescueSetOptions {
  readonly weights?: Readonly<Record<string, number>>;
  readonly digest?: string;
  readonly precomputedRanks?: Map<string, MvRankInfo>;
}

/** Rescue decision: the subset of condemnedIds ranking in the top 30% of their tenant's non-pinned set by learned score.
 * Pass `precomputedRanks` to skip the internal ranking so the whole-store pass runs once per sleep; `weights`/`digest` overrides exist for tests only. */
export function rescueSet(
  entries: MemoryEntry[],
  condemnedIds: Set<string>,
  now: Date,
  options: RescueSetOptions = {},
): Set<string> {
  const { weights = MEMORY_VALUE_WEIGHTS, digest = SOURCE_ARTIFACT_SHA256, precomputedRanks } = options;
  validateWeights(weights, digest); // fail loud before any rescue computation
  const ranked = precomputedRanks ?? rankNonPinnedByTenant(entries, now, weights, digest);
  const rescued = new Set<string>();
  for (const id of condemnedIds) {
    const info = ranked.get(id);
    // An explicit finite guard, not just -Infinity sorting last: when a whole tenant
    // ties at -Infinity, rank alone could place one inside keepN.
    if (info && info.rank <= info.keepN && Number.isFinite(info.score)) rescued.add(id);
  }
  return rescued;
}
