// The eval-only switches (HIPPO_ABLATE_*, HIPPO_EVAL_RECENCY_DAYS), which only eval roots read, and
// the HIPPO_FAKE_NOW clock every root reads; each strength switch becomes a StrengthModel value.
import { type EvalSwitches, type RankAblation } from '../base/memory/eval-switches.js';
import { PRODUCTION_STRENGTH, type StrengthModel } from '../base/memory/strength.js';
import type { Clock } from '../base/ports/infra.js';
import { hostClock } from '../host/clock.js';
import { envByName, envFakeNowMs, envFlagOn } from '../base/util/env.js';

const ABLATE = {
  decay: 'HIPPO_ABLATE_DECAY',
  recallBoost: 'HIPPO_ABLATE_RECALL_BOOST',
  outcome: 'HIPPO_ABLATE_OUTCOME',
  outcomeSlow: 'HIPPO_ABLATE_OUTCOME_SLOW',
  outcomeFast: 'HIPPO_ABLATE_OUTCOME_FAST',
  recency: 'HIPPO_ABLATE_RECENCY',
} as const;

const ablated = (cut: keyof typeof ABLATE): boolean => envFlagOn(ABLATE[cut]);

/** The three strength switches an eval cuts one mechanism with. */
export interface StrengthAblation {
  readonly decay: boolean;
  readonly recallBoost: boolean;
  readonly outcomeSlow: boolean;
}

/** `base` with each cut mechanism off: decay also drops the wrong-mark halvings (amendment A1),
 * and the slow outcome channel is the reward slope and the wrong marks together. */
export function strengthModelUnder(
  ablation: StrengthAblation,
  base: StrengthModel = PRODUCTION_STRENGTH,
): StrengthModel {
  if (!ablation.decay && !ablation.recallBoost && !ablation.outcomeSlow) return base;
  return Object.freeze({
    ...base,
    decays: base.decays && !ablation.decay,
    recallStrengthens: base.recallStrengthens && !ablation.recallBoost,
    rewardSlope: ablation.outcomeSlow ? 0 : base.rewardSlope,
    maxWrongHalvings: ablation.decay || ablation.outcomeSlow ? 0 : base.maxWrongHalvings,
  });
}

export function isRecallBoostAblated(): boolean {
  return ablated('recallBoost');
}

export function isOutcomeFastAblated(): boolean {
  return ablated('outcome') || ablated('outcomeFast');
}

/** HIPPO_EVAL_RECENCY_DAYS when it is a positive number, else null. */
function evalRecencyDays(): number | null {
  const days = Number(envByName('HIPPO_EVAL_RECENCY_DAYS'));
  return Number.isFinite(days) && days > 0 ? days : null;
}

/** The strength switches as the environment holds them. */
function strengthAblation(): StrengthAblation {
  return {
    decay: ablated('decay'),
    recallBoost: ablated('recallBoost'),
    outcomeSlow: ablated('outcome') || ablated('outcomeSlow'),
  };
}

/** The rank switches as the environment holds them. */
function rankAblation(): RankAblation {
  return {
    recency: ablated('recency'),
    recencyDays: evalRecencyDays(),
    outcomeFast: isOutcomeFastAblated(),
  };
}

/** The strength model and rank switches as the environment holds them, for an eval root to hand
 * its rankings. */
export function evalSwitches(): EvalSwitches {
  return { strength: strengthModelUnder(strengthAblation()), rank: rankAblation() };
}

/** The clock a root's Context reads: fixed at HIPPO_FAKE_NOW as it stands now, else the wall
 * clock. */
export function evalClock(): Clock {
  return hostClock(envFakeNowMs());
}

/** HIPPO_FAKE_NOW when set and parseable, else the wall clock, read at each call: the entry
 * layer's default `now`. */
export function evalNow(): Date {
  return evalClock()();
}
