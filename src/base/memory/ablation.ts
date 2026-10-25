// EVAL-ONLY switches (HIPPO_ABLATE_*, HIPPO_EVAL_RECENCY_DAYS, HIPPO_FAKE_NOW), each cutting ONE mechanism; not a
// production surface. Readers read the environment when called, so a per-row loop reads them once and hands them down.
// See docs/ARCHITECTURE.md#srccoreablationts.

import { NO_STRENGTH_ABLATION, type EvalSwitches, type RankAblation, type StrengthAblation } from './eval-switches.js';
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
function rankAblation(): RankAblation {
  return { recency: envAblateRecency(), recencyDays: envEvalRecencyDays(), outcomeFast: isOutcomeFastAblated() };
}

/** Every switch and the clock as the environment holds them, for a root to hand its rankings. */
export function evalSwitches(): EvalSwitches {
  return { strength: strengthAblation(), rank: rankAblation(), fakeNowMs: envFakeNowMs() };
}

/** The default `now` for lifecycle computations: HIPPO_FAKE_NOW when set and parseable, else the real clock; an
 * explicit `now` parameter always wins. */
export function evalNow(): Date {
  const ms = envFakeNowMs();
  return ms === null ? new Date() : new Date(ms);
}
