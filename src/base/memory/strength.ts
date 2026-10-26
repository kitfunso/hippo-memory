// How strong a memory is at an instant: decay, the reward factor, the retrieval boost, the emotional weight and the
// confidence facets, all under one StrengthModel the caller passes with the time.
import type { ConfidenceLevel, EmotionalValence, MemoryEntry } from './entry.js';
import { DAY_MS } from '../util/time.js';

/** The slopes, bases and channels strength scoring runs on; an eval builds another value at its root. */
export interface StrengthModel {
  /** Strength left after one half-life; also what each wrong mark multiplies by. */
  readonly decayBase: number;
  /** Half-life stretch at a fully good outcome record (shrink at a fully bad one). */
  readonly rewardSlope: number;
  /** Strength each doubling of the retrieval count adds. */
  readonly retrievalBoostSlope: number;
  /** The most halvings bad outcome marks apply; bad marks alone never push a memory under sleep's 0.05 retire line. */
  readonly maxWrongHalvings: number;
  /** Multiplies the `negative` valence weight, after parseLossAversionRatio's floor. */
  readonly lossAversionRatio: number;
  /** Strength fades with time since the decay anchor; off, it holds at the boost and emotional weight. */
  readonly decays: boolean;
  /** A recall boosts strength, moves the decay anchor and lengthens the half-life; off, the anchor is `created`. */
  readonly recallStrengthens: boolean;
}

/** The model every production path scores with; strengthSql (sqlite/runtime/rule-sql.ts) reads the same fields. */
export const PRODUCTION_STRENGTH: StrengthModel = Object.freeze({
  decayBase: 0.5,
  rewardSlope: 0.5,
  retrievalBoostSlope: 0.1,
  maxWrongHalvings: 3,
  lossAversionRatio: 1.0,
  decays: true,
  recallStrengthens: true,
});

export const FALLBACK_HALF_LIFE_DAYS = 7;

/** Base half-life before deriveHalfLife's multipliers: 7 lost the current fact far more often and 730 did no better.
 * `hippo sleep` moves memories still on an older base (src/domain/consolidate/half-life-migration.ts). */
export const DEFAULT_HALF_LIFE_DAYS = 365;

/** The flat half-life the object writers gave their memories before they took the default. */
export const LEGACY_TYPED_HALF_LIFE = 90;

// Losses weigh ~2x gains (Lovallo-Kahneman), so negative is 2.0; HIPPO_LOSS_AVERSION_RATIO scales it per process.
export const EMOTIONAL_MULTIPLIERS = {
  neutral: 1.0,
  positive: 1.0,
  negative: 2.0, // error-tagged
  critical: 2.0,
} satisfies Record<EmotionalValence, number>;

// A lower ratio can drop an error-tagged memory under sleep's DECAY_THRESHOLD (src/domain/consolidate/decay.ts), so
// values below it fall back to 1.0.
const LOSS_AVERSION_RATIO_MIN = 0.5;

/** HIPPO_LOSS_AVERSION_RATIO as scoring reads it: unset, unparseable or below the floor is 1.0. */
export function parseLossAversionRatio(raw: string | number | undefined): number {
  const parsed = raw === undefined || raw === '' ? 1.0 : Number(raw);
  return Number.isFinite(parsed) && parsed >= LOSS_AVERSION_RATIO_MIN ? parsed : 1.0;
}

/** `model` with the root's HIPPO_LOSS_AVERSION_RATIO, floored as parseLossAversionRatio floors it. */
export function withLossAversion(model: StrengthModel, ratio: string | number | undefined): StrengthModel {
  const lossAversionRatio = parseLossAversionRatio(ratio);
  return lossAversionRatio === model.lossAversionRatio ? model : Object.freeze({ ...model, lossAversionRatio });
}

/** Scales only the `negative` multiplier; `critical` stays unscaled so the knob moves just the losses-vs-gains
 * claim. */
export function applyLossAversionRatio(valence: EmotionalValence, baseMultiplier: number, ratio: number): number {
  if (valence !== 'negative') return baseMultiplier;
  return baseMultiplier * ratio;
}

/** 1 + rewardSlope * (pos - neg) / (pos + neg + 1), 1.0 with no outcomes; it scales the effective half-life. */
export function calculateRewardFactor(
  entry: Pick<MemoryEntry, 'outcomePositive' | 'outcomeNegative'>,
  model: StrengthModel,
): number {
  const pos = entry.outcomePositive ?? 0;
  const neg = entry.outcomeNegative ?? 0;
  if (pos === 0 && neg === 0) return 1.0;
  const ratio = (pos - neg) / (pos + neg + 1);
  return 1 + model.rewardSlope * ratio;
}

/** Bad outcome marks past good ones, from zero up to maxWrongHalvings; each halves strength and stops recall
 * strengthening, so a correction outranks pinning. */
export function netWrong(
  entry: Pick<MemoryEntry, 'outcomePositive' | 'outcomeNegative'>,
  model: StrengthModel,
): number {
  const marks = Math.max(0, (entry.outcomeNegative ?? 0) - (entry.outcomePositive ?? 0));
  return Math.min(marks, model.maxWrongHalvings);
}

/** What calculateStrength reads, so a caller can score a row without loading its text. */
export type StrengthInputs = Pick<
  MemoryEntry,
  | 'pinned'
  | 'created'
  | 'lastRetrieved'
  | 'halfLifeDays'
  | 'retrievalCount'
  | 'emotionalValence'
  | 'outcomePositive'
  | 'outcomeNegative'
>;

/** clock = wall time, session = per sleep cycle (intermittent agents), adaptive = half-life scaled by session pace. */
export interface DecayBasis {
  decayBasis?: 'clock' | 'session' | 'adaptive';
  /** Average interval between sleep cycles, in days. Used by 'adaptive' and 'session' modes. */
  avgSessionIntervalDays?: number;
  /** Total sleep cycles completed. Used by consolidation tracking. */
  sleepCount?: number;
}

/** Strength at `now` = decay * retrieval boost * emotional multiplier, clamped to [0, 1]. Pinned memories skip time
 * decay, but being marked wrong still fades them (netWrong). */
export function calculateStrength(
  entry: StrengthInputs,
  now: Date,
  model: StrengthModel,
  basis: DecayBasis = {},
): number {
  // Being marked wrong outranks every shield: pinning, error tags, heavy recall.
  const wrong = netWrong(entry, model);
  const wrongPenalty = Math.pow(model.decayBase, wrong);
  if (entry.pinned) return wrongPenalty;

  const anchor = new Date(model.recallStrengthens ? entry.lastRetrieved : entry.created);
  const daysSince = (now.getTime() - anchor.getTime()) / DAY_MS;
  const effectiveHalfLife = entry.halfLifeDays * calculateRewardFactor(entry, model);

  // Guard: zero half-life causes 0/0 = NaN in the exponent
  if (effectiveHalfLife <= 0) return 0.0;

  // Without decay the [0,1] clamp below caps the boost at baseline.
  const decay = model.decays ? Math.pow(model.decayBase, decayExponentFor(basis, daysSince, effectiveHalfLife)) : 1.0;
  const retrievalBoost =
    model.recallStrengthens && wrong === 0 ? 1 + model.retrievalBoostSlope * Math.log2(entry.retrievalCount + 1) : 1.0;

  const baseMultiplier = EMOTIONAL_MULTIPLIERS[entry.emotionalValence] ?? 1.0;
  const emotionalMultiplier = applyLossAversionRatio(entry.emotionalValence, baseMultiplier, model.lossAversionRatio);

  const raw = decay * retrievalBoost * emotionalMultiplier;

  const clamped = Math.min(1.0, Math.max(0.0, raw));
  return Number.isFinite(clamped) ? clamped * wrongPenalty : 0.0;
}

function decayExponentFor(basis: DecayBasis, daysSince: number, halfLifeDays: number): number {
  let effectiveHalfLife = halfLifeDays;
  const mode = basis.decayBasis ?? 'clock';
  if (mode === 'session') {
    // Each sleep cycle counts as one "day"; sessions since last retrieval are estimated from the average interval.
    const avgInterval = basis.avgSessionIntervalDays ?? 1;
    const sessionsSince = avgInterval > 0 ? Math.max(0, daysSince / avgInterval) : daysSince;
    return sessionsSince / effectiveHalfLife;
  }
  if (mode === 'adaptive') {
    // Scale half-life by session frequency: infrequent agents get longer half-lives
    const avgInterval = basis.avgSessionIntervalDays ?? 0;
    if (avgInterval > 1) {
      effectiveHalfLife *= avgInterval;
    }
    return daysSince / effectiveHalfLife;
  }
  return daysSince / effectiveHalfLife;
}

/** What the confidence facets read, so a caller can derive them from a row it loaded only in part. */
export type ConfidenceInputs = Pick<MemoryEntry, 'pinned' | 'confidence' | 'lastRetrieved'>;

// Days without a retrieval before trust lapses; pinned and verified rows are exempt by policy.
const AGED_OUT_AFTER_DAYS = 30;

function isAgedOut(entry: ConfidenceInputs, now: Date): boolean {
  if (entry.pinned || entry.confidence === 'verified') return false;
  const lastRetrieved = new Date(entry.lastRetrieved);
  return (now.getTime() - lastRetrieved.getTime()) / DAY_MS > AGED_OUT_AFTER_DAYS;
}

export interface ConfidenceFacets {
  // Stored: why we believe the entry. Derived: nobody retrieved it lately.
  tier: ConfidenceLevel;
  agedOut: boolean;
}

export function confidenceFacets(entry: ConfidenceInputs, now: Date): ConfidenceFacets {
  return { tier: entry.confidence, agedOut: isAgedOut(entry, now) };
}

// An aged-out row warns on its own, since its stored tier alone would hide it.
export function confidenceLabel(entry: ConfidenceInputs, now: Date) {
  const { tier, agedOut } = confidenceFacets(entry, now);
  return {
    text: agedOut ? `${tier}, aged` : tier,
    warn: agedOut || tier === 'stale' || tier === 'inferred',
  };
}

/** The stored confidence, or 'stale' once aged out (no retrieval for AGED_OUT_AFTER_DAYS; pinned and verified
 * exempt). */
export function resolveConfidence(entry: ConfidenceInputs, now: Date): ConfidenceLevel {
  return isAgedOut(entry, now) ? 'stale' : entry.confidence;
}
