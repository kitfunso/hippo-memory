/** EVAL-ONLY ablation switches (HIPPO_ABLATE_*, HIPPO_EVAL_RECENCY_DAYS, HIPPO_FAKE_NOW): each cuts ONE mechanism (outcome also replayPriority bias).
 * Not a production surface. Env is read once per process; tests that mutate these vars MUST call _resetAblationCacheForTests() in beforeEach AND afterEach. See
 * docs/ARCHITECTURE.md#srccoreablationts. */

import {
  envAblateDecay, envAblateOutcome, envAblateOutcomeFast, envAblateOutcomeSlow, envAblateRecallBoost, envAblateRecency,
  envEvalRecencyDays, envFakeNowMs,
} from '../util/env.js';

interface AblationFlags {
  decay: boolean;
  recallBoost: boolean;
  outcomeSlow: boolean;
  outcomeFast: boolean;
  recency: boolean;
  /** Parsed HIPPO_EVAL_RECENCY_DAYS, or null when unset/invalid. */
  recencyDays: number | null;
  /** Parsed HIPPO_FAKE_NOW epoch millis, or null when unset/invalid. */
  fakeNowMs: number | null;
}

let _cache: AblationFlags | undefined;

function readFlags(): AblationFlags {
  if (_cache !== undefined) return _cache;
  const outcomeBoth = envAblateOutcome();
  _cache = {
    decay: envAblateDecay(),
    recallBoost: envAblateRecallBoost(),
    outcomeSlow: outcomeBoth || envAblateOutcomeSlow(),
    outcomeFast: outcomeBoth || envAblateOutcomeFast(),
    recency: envAblateRecency(),
    recencyDays: envEvalRecencyDays(),
    fakeNowMs: envFakeNowMs(),
  };
  return _cache;
}

export function isDecayAblated(): boolean {
  return readFlags().decay;
}

export function isRecallBoostAblated(): boolean {
  return readFlags().recallBoost;
}

export function isOutcomeSlowAblated(): boolean {
  return readFlags().outcomeSlow;
}

export function isOutcomeFastAblated(): boolean {
  return readFlags().outcomeFast;
}

export function isRecencyAblated(): boolean {
  return readFlags().recency;
}

/** HIPPO_EVAL_RECENCY_DAYS when it is a positive number, else null (callers keep their default). */
export function evalRecencyScaleDays(): number | null {
  return readFlags().recencyDays;
}

/** The default `now` for lifecycle computations: HIPPO_FAKE_NOW when set and parseable, else the real clock; an explicit `now` parameter always wins. */
export function evalNow(): Date {
  const ms = readFlags().fakeNowMs;
  return ms === null ? new Date() : new Date(ms);
}

/** Test-only. See module JSDoc: call in BOTH beforeEach AND afterEach. */
export function _resetAblationCacheForTests(): void {
  _cache = undefined;
}
