/**
 * Learned memory-value scorer, wired into the sleep decay pass as a
 * rescue-only veto.
 *
 * computeMvFeatures mirrors benchmarks/memory-value/extract.mjs's
 * computeFeatures for the 8 live dims the fitter optimized over
 * (FIT_DIMS) — the only dims MEMORY_VALUE_WEIGHTS carries a weight for.
 * Any future edit to either side must keep them byte-equivalent; the parity
 * test in tests/memory-value-wiring.test.ts enforces this.
 *
 * scoreEntries mirrors benchmarks/memory-value/evaluate.mjs's per-store
 * min-max normalization + weighted scorer (no additional orientation
 * multiply — the frozen weights already encode sign/orientation).
 *
 * rescueSet implements rescue-only semantics: a condemned entry is
 * rescued iff its learned score ranks in the top 30% (RESCUE_BUDGET, the
 * measured keep-budget operating point) of its own tenant's non-pinned
 * candidate set. Deletes(flag-on) subset Deletes(flag-off) by construction — this
 * function can only ever shrink the condemned set, never grow it.
 */

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

/**
 * Small-tenant degeneracy: below this per-tenant non-pinned candidate-set
 * size, a rank statistic is noise (the measured evidence says nothing about
 * tiny scale), and the floor prevents immortal-entry
 * convergence: keepN=ceil(0.3*N) guarantees >=1 rescue at N=1, so without a
 * floor a condemned-only 1-entry tenant would be rescued every single sleep
 * forever. A condemned-only tenant below the floor instead drains normally
 * as entries are deleted: the surviving rescued subset only ever shrinks
 * toward 0, never regrows past 10 to regain eligibility on its own. Code
 * constant tied to that reasoning, not user-tunable (same posture as
 * RESCUE_BUDGET).
 */
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

/**
 * Blind v1 feature dict for one MemoryEntry, restricted to the 8 dims the
 * frozen weights carry (mirrors extract.mjs's computeFeatures).
 *
 * CRITICAL: `strength` is CLOCK-BASIS `calculateStrength(entry, now)` with
 * NO DecayOptions — that is how the frozen weights' training features were
 * computed (extract.mjs never passes decayOpts). Passing the production
 * decay basis (config.decayBasis via consolidate.ts's decayOpts) into this
 * feature would silently break parity with the frozen weight vector. This
 * is an intentional divergence from the condemnation TRIGGER in
 * consolidate.ts, which keeps using decayOpts as today — only the rescue
 * FEATURE is clock-basis.
 */
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

/**
 * Throws if the weight constant is malformed: fewer/extra dims, a
 * non-finite weight value, or a missing source digest. Flag-on + a broken
 * constant must THROW, never silently behave as flag-off.
 *
 * Parameterized (defaults to the real frozen singleton) so the throw
 * conditions are directly unit-testable without mutating the frozen
 * MEMORY_VALUE_WEIGHTS export — mirrors fit.mjs's verifyFrozenWeights
 * (see tests/memory-value-fit.test.ts's `describe('verifyFrozenWeights')`).
 */
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

/**
 * Min-max normalize each of the 8 features over the given entry set
 * (constant feature -> 0, matching evaluate.mjs), then score = dot(weights,
 * normalized). The normalization context is exactly the entries passed in —
 * callers control the bounded scope (per-tenant, non-pinned).
 *
 * `weights` defaults to the real frozen singleton; parameterized (like
 * validateWeights) so callers/tests can score against an explicit vector
 * without touching the module singleton.
 *
 * Non-finite features: Date.parse on a malformed `created`
 * string yields NaN, and NaN would silently corrupt every OTHER entry's
 * min-max in the same group. An entry with ANY non-finite computed feature
 * is excluded from the normalization context entirely (its raw values never
 * touch min/max) and always scores -Infinity — the lowest possible score, so
 * it sorts to the bottom of its tenant deterministically and (via rescueSet's
 * explicit finite-score guard below) can never be rescued. Conservative
 * direction: deletes(flag-on) subset deletes(flag-off) still holds.
 */
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

/** Per-entry rank context within its tenant's non-pinned candidate set —
 *  the score-rank basis both rescueSet's rescue decision and consolidate.ts's
 *  audit-row metadata read from. */
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

/**
 * Groups non-pinned entries by tenantId, scores + ranks each tenant's
 * group independently, and returns per-entry rank context for every
 * non-pinned entry (not just condemned ones) — the shared basis for both
 * rescueSet's rescue decision and consolidate.ts's audit-row rank context,
 * so the two never compute the ranking differently.
 *
 * `weights`/`digest` default to the real frozen singleton — parameterized
 * (like validateWeights/scoreEntries) purely for direct unit-testability of
 * the fail-loud path, never overridden by production callers.
 */
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

/**
 * Rescue decision: a condemned entry is rescued iff it ranks in the top
 * 30% of its tenant's non-pinned candidate set by learned score. Returns the
 * subset of condemnedIds that are rescued — the caller filters commits
 * (rescued -> survivors) and threads the same set into detectConflicts.
 *
 * `weights`/`digest` default to the real frozen singleton; production
 * callers (consolidate.ts) never pass overrides — the params exist purely so
 * "flag on + a broken constant throws" is directly testable end-to-end
 * through this function without mutating the frozen module singleton.
 *
 * `precomputedRanks`: when the caller has already
 * computed the per-tenant ranking (e.g. consolidate.ts needs it separately
 * for detail/audit rank context), pass it here to skip the internal
 * rankNonPinnedByTenant call — the whole-store ranking pass then runs
 * exactly once per sleep instead of twice. Omitted (the default), rescueSet
 * computes it internally as before — existing callers/tests are unaffected.
 */
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
