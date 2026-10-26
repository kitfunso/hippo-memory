// The eval-only switches (HIPPO_ABLATE_*, HIPPO_EVAL_RECENCY_DAYS) and the HIPPO_FAKE_NOW clock as the environment
// holds them, read when a root builds its ports; each strength switch becomes a StrengthModel value, never a branch.
import { type EvalSwitches, type RankAblation } from '../base/memory/eval-switches.js';
import { PRODUCTION_STRENGTH, type StrengthModel } from '../base/memory/strength.js';
import type { Clock, StoreRules } from '../base/ports/infra.js';
import { hostClock } from '../host/clock.js';
import {
  envAblateDecay,
  envAblateOutcome,
  envAblateOutcomeFast,
  envAblateOutcomeSlow,
  envAblateRecallBoost,
  envAblateRecency,
  envEvalRecencyDays,
  envFakeNowMs,
} from '../base/util/env.js';

/** The three strength switches an eval cuts one mechanism with. */
export interface StrengthAblation {
  readonly decay: boolean;
  readonly recallBoost: boolean;
  readonly outcomeSlow: boolean;
}

/** `base` with each cut mechanism off: decay also drops the wrong-mark halvings (amendment A1), and the slow outcome
 * channel is the reward slope and the wrong marks together. */
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
  return envAblateRecallBoost();
}

export function isOutcomeFastAblated(): boolean {
  return envAblateOutcome() || envAblateOutcomeFast();
}

/** The strength switches as the environment holds them. */
function strengthAblation(): StrengthAblation {
  return {
    decay: envAblateDecay(),
    recallBoost: envAblateRecallBoost(),
    outcomeSlow: envAblateOutcome() || envAblateOutcomeSlow(),
  };
}

/** The rank switches as the environment holds them. */
function rankAblation(): RankAblation {
  return { recency: envAblateRecency(), recencyDays: envEvalRecencyDays(), outcomeFast: isOutcomeFastAblated() };
}

/** The strength model and rank switches as the environment holds them, for a root to hand its rankings. */
export function evalSwitches(): EvalSwitches {
  return { strength: strengthModelUnder(strengthAblation()), rank: rankAblation() };
}

/** The clock a root's Context reads: fixed at HIPPO_FAKE_NOW as it stands now, else the wall clock. */
export function evalClock(): Clock {
  return hostClock(envFakeNowMs());
}

/** What a root opens its store with: the eval strength model at its HIPPO_LOSS_AVERSION_RATIO, and HIPPO_FAKE_NOW. */
export function evalStoreRules(lossAversionRatio: number | undefined): StoreRules {
  return { strength: evalSwitches().strength, lossAversionRatio, fakeNowMs: envFakeNowMs() };
}

/** HIPPO_FAKE_NOW when set and parseable, else the wall clock, read at each call: the entry layer's default `now`. */
export function evalNow(): Date {
  return evalClock()();
}
