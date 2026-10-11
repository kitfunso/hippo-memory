import { envSummaryDeboost } from '../util/env.js';
import { calculateStrength, CHURN_STALE_TAG, type MemoryEntry } from '../core/memory.js';
import { isOutcomeFastAblated, isRecencyAblated, evalRecencyScaleDays } from '../core/ablation.js';
import { pathBoostMultiplier } from './path-context.js';
import { scopeMatch } from '../core/active-scope.js';
import { temporalBoost, type TemporalDirection, type TemporalRange } from './temporal.js';
import { DAY_MS } from '../util/time.js';

const CHURN_STALE_RANK_MULTIPLIER = 0.5; // SHORTCUT: untuned; measure on real recall before any default.

const DECISION_TAG_BOOST = 1.2;
// A memory tagged for the active scope outranks a neutral one; one tagged for another scope is demoted.
const SCOPE_MATCH_BOOST = 1.5;
const SCOPE_MISMATCH_BOOST = 0.5;
const EXTRACTION_TAG_BOOST = 1.3;
// The outcome nudge is 1 + slope * tanh(net / 2), clamped so one outcome streak cannot swamp lexical rank.
const OUTCOME_NUDGE_SLOPE = 0.15;
const OUTCOME_NUDGE_MIN = 0.85;
const OUTCOME_NUDGE_MAX = 1.15;
// Strength and recency enter the rank as floor + span * signal, so a weak or old memory keeps most of its lexical score.
export const STRENGTH_RANK_FLOOR = 0.5;
export const STRENGTH_RANK_SPAN = 0.5;
const RECENCY_RANK_FLOOR = 0.8;
const RECENCY_RANK_SPAN = 0.2;
const RECENCY_SCALE_DAYS = 30;
const DEFAULT_SUMMARY_DEBOOST = 0.85;
const DEFAULT_FRESHNESS_BOOST = 1.05;
const FRESHNESS_WINDOW_MS = 7 * DAY_MS;

export function churnStaleFactor(entry: MemoryEntry): number {
  return entry.tags.includes(CHURN_STALE_TAG) ? CHURN_STALE_RANK_MULTIPLIER : 1.0;
}

function recencyBoost(entry: MemoryEntry, now: Date): number {
  if (isRecencyAblated()) return 1; // EVAL-ONLY ablation (see ablation.ts)
  const created = new Date(entry.created);
  const ageDays = (now.getTime() - created.getTime()) / DAY_MS;
  return Math.exp(-ageDays / (evalRecencyScaleDays() ?? RECENCY_SCALE_DAYS));
}

/** Retrieval-time outcome nudge in [0.85, 1.15]; the bm25-outcome eval baseline ranks with it too. */
export function outcomeMultiplier(entry: MemoryEntry): number {
  const pos = entry.outcome_positive ?? 0;
  const neg = entry.outcome_negative ?? 0;
  if (isOutcomeFastAblated() || (pos === 0 && neg === 0)) return 1.0; // EVAL-ONLY ablation (see ablation.ts)
  return Math.max(OUTCOME_NUDGE_MIN, Math.min(OUTCOME_NUDGE_MAX, 1 + OUTCOME_NUDGE_SLOPE * Math.tanh((pos - neg) / 2)));
}

/** A DAG summary is a topic summary (level 2) or an entity profile (level 3); both take the same deboost. */
export function isDagSummary(entry: MemoryEntry): boolean {
  return entry.dag_level === 2 || entry.dag_level === 3;
}

/** Summary deboost: per-call, then HIPPO_SUMMARY_DEBOOST, then 0.85; values outside (0, 1] fall through. */
export function resolveSummaryDeboost(perCall?: number): number {
  if (perCall !== undefined && Number.isFinite(perCall) && perCall > 0 && perCall <= 1) {
    return perCall;
  }
  const raw = envSummaryDeboost();
  if (raw !== undefined) {
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) {
      return parsed;
    }
  }
  return DEFAULT_SUMMARY_DEBOOST;
}

/** 1.05 for a summary rebuilt within the window; null, unparseable and future timestamps get 1.0. */
function summaryFreshnessMultiplier(entry: MemoryEntry, now: Date): number {
  if (!isDagSummary(entry) || !entry.last_rebuilt_at) return 1.0;
  const rebuiltMs = new Date(entry.last_rebuilt_at).getTime();
  if (!Number.isFinite(rebuiltMs)) return 1.0;
  const ageMs = now.getTime() - rebuiltMs;
  return ageMs >= 0 && ageMs <= FRESHNESS_WINDOW_MS ? DEFAULT_FRESHNESS_BOOST : 1.0;
}

export interface SummaryScoring {
  deboost: number;
  freshness: boolean;
}

/** The sync BM25 path applies no summary scoring; multiplying by exactly 1 keeps its scores bit-identical. */
export const NO_SUMMARY_SCORING: SummaryScoring = { deboost: 1, freshness: false };

export function summaryScoring(options: { summaryDeboost?: number; summaryFreshness?: boolean }): SummaryScoring {
  return { deboost: resolveSummaryDeboost(options.summaryDeboost), freshness: options.summaryFreshness ?? true };
}

export function summaryMultipliers(entry: MemoryEntry, now: Date, s: SummaryScoring) {
  if (!isDagSummary(entry)) return { deboost: 1.0, freshness: 1.0 };
  return { deboost: s.deboost, freshness: s.freshness ? summaryFreshnessMultiplier(entry, now) : 1.0 };
}

export function strengthRecencyMultipliers(entry: MemoryEntry, now: Date) {
  return {
    strength: STRENGTH_RANK_FLOOR + STRENGTH_RANK_SPAN * calculateStrength(entry, now),
    recency: RECENCY_RANK_FLOOR + RECENCY_RANK_SPAN * recencyBoost(entry, now),
  };
}

/** The rank multiplier for a scopeMatch signal: match, mismatch or neutral. */
export function scopeBoostFor(signal: -1 | 0 | 1): number {
  return signal === 1 ? SCOPE_MATCH_BOOST : signal === -1 ? SCOPE_MISMATCH_BOOST : 1.0;
}

export interface BoostContext {
  now: Date;
  pathTags: string[];
  scope: string | null;
  temporal: { direction: TemporalDirection; range: TemporalRange };
  /** The sync BM25 path never applied the outcome nudge. */
  outcome: boolean;
  summary: SummaryScoring;
}

export interface AppliedBoosts {
  score: number;
  decisionBoost: number;
  churnStaleMultiplier: number;
  pathBoost: number;
  outcomeBoost: number;
  scopeBoost: number;
  summaryDeboost: number;
  summaryFreshnessBoost: number;
}

/** Applies every rank multiplier one at a time, in a fixed order, so float rounding matches across paths. */
export function applyRankBoosts(score: number, entry: MemoryEntry, ctx: BoostContext): AppliedBoosts {
  const decisionBoost = entry.tags.includes('decision') ? DECISION_TAG_BOOST : 1.0;
  const churnStaleMultiplier = churnStaleFactor(entry);
  const pathBoost = pathBoostMultiplier(entry.tags, ctx.pathTags);
  const outcomeBoost = ctx.outcome ? outcomeMultiplier(entry) : 1.0;
  const scopeBoost = scopeBoostFor(scopeMatch(entry.tags, ctx.scope));
  const extractionBoost = entry.tags.includes('extracted') ? EXTRACTION_TAG_BOOST : 1.0;
  const summary = summaryMultipliers(entry, ctx.now, ctx.summary);
  let s = score;
  s *= decisionBoost;
  s *= churnStaleMultiplier;
  s *= pathBoost;
  s *= outcomeBoost;
  s *= scopeBoost;
  s *= extractionBoost;
  s *= temporalBoost(entry, ctx.temporal.direction, ctx.temporal.range);
  s *= summary.deboost * summary.freshness;
  return {
    score: s, decisionBoost, churnStaleMultiplier, pathBoost, outcomeBoost, scopeBoost,
    summaryDeboost: summary.deboost, summaryFreshnessBoost: summary.freshness,
  };
}
