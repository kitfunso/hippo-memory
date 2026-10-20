// EVAL-ONLY switches (HIPPO_ABLATE_*, HIPPO_EVAL_RECENCY_DAYS, HIPPO_FAKE_NOW), each cutting ONE mechanism; not a
// production surface. Readers read the environment when called, so a per-row loop reads them once and hands them down.
// See docs/ARCHITECTURE.md#srccoreablationts.

import {
  envAblateDecay,
  envAblateOutcome,
  envAblateOutcomeFast,
  envAblateOutcomeSlow,
  envAblateRecallBoost,
  envAblateRecency,
  envEvalRecencyDays,
  envFakeNowMs,
} from '../util/env.js';

/** The three switches strength scoring honours, resolved by the entry layer and handed to base in DecayOptions. */
export interface StrengthAblation {
  readonly decay: boolean;
  readonly recallBoost: boolean;
  readonly outcomeSlow: boolean;
}

/** Production scoring: nothing ablated. Core falls back to this, so it never reads the environment. */
export const NO_STRENGTH_ABLATION: StrengthAblation = Object.freeze({
  decay: false,
  recallBoost: false,
  outcomeSlow: false,
});

/** The switches recall's rank boosts honour, read once per search and handed down in its boost context. */
export interface RankAblation {
  readonly recency: boolean;
  /** HIPPO_EVAL_RECENCY_DAYS when it is a positive number, else null (the 30-day scale stays). */
  readonly recencyDays: number | null;
  readonly outcomeFast: boolean;
}

export function isDecayAblated(): boolean {
  return envAblateDecay();
}

export function isRecallBoostAblated(): boolean {
  return envAblateRecallBoost();
}

export function isOutcomeSlowAblated(): boolean {
  return envAblateOutcome() || envAblateOutcomeSlow();
}

export function isOutcomeFastAblated(): boolean {
  return envAblateOutcome() || envAblateOutcomeFast();
}

/** The strength switches as the environment holds them; entry-layer callers pass them as `DecayOptions.ablation`. */
export function strengthAblation(): StrengthAblation {
  const decay = isDecayAblated();
  const recallBoost = isRecallBoostAblated();
  const outcomeSlow = isOutcomeSlowAblated();
  if (!decay && !recallBoost && !outcomeSlow) return NO_STRENGTH_ABLATION;
  return Object.freeze({ decay, recallBoost, outcomeSlow });
}

/** The rank switches as the environment holds them. */
export function rankAblation(): RankAblation {
  return { recency: envAblateRecency(), recencyDays: envEvalRecencyDays(), outcomeFast: isOutcomeFastAblated() };
}

/** The default `now` for lifecycle computations: HIPPO_FAKE_NOW when set and parseable, else the real clock; an
 * explicit `now` parameter always wins. */
export function evalNow(): Date {
  const ms = envFakeNowMs();
  return ms === null ? new Date() : new Date(ms);
}
