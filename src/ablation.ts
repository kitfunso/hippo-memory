// EVAL-ONLY lifecycle ablation switches, not production config — each flag
// isolates one lifecycle mechanism for causal measurement. Flag reference +
// hidden decay/outcome coupling notes: docs/ARCHITECTURE.md.

interface AblationFlags {
  decay: boolean;
  recallBoost: boolean;
  outcomeSlow: boolean;
  outcomeFast: boolean;
  /** Parsed HIPPO_FAKE_NOW epoch millis, or null when unset/invalid. */
  fakeNowMs: number | null;
}

let _cache: AblationFlags | undefined;

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function readFlags(): AblationFlags {
  if (_cache !== undefined) return _cache;
  const outcomeBoth = isTruthy(process.env.HIPPO_ABLATE_OUTCOME);
  let fakeNowMs: number | null = null;
  const rawNow = process.env.HIPPO_FAKE_NOW;
  if (rawNow !== undefined && rawNow !== '') {
    // Round-trip validated, not just parsed: rejects junk, locale dates, and rolled-over dates like '2026-02-31'.
    const parsed = Date.parse(rawNow);
    if (Number.isFinite(parsed) && new Date(parsed).toISOString() === rawNow) {
      fakeNowMs = parsed;
    }
  }
  _cache = {
    decay: isTruthy(process.env.HIPPO_ABLATE_DECAY),
    recallBoost: isTruthy(process.env.HIPPO_ABLATE_RECALL_BOOST),
    outcomeSlow: outcomeBoth || isTruthy(process.env.HIPPO_ABLATE_OUTCOME_SLOW),
    outcomeFast: outcomeBoth || isTruthy(process.env.HIPPO_ABLATE_OUTCOME_FAST),
    fakeNowMs,
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

/** Default `now` for lifecycle computations: HIPPO_FAKE_NOW when set/parseable, else the real clock; explicit `now` params always win. */
export function evalNow(): Date {
  const ms = readFlags().fakeNowMs;
  return ms === null ? new Date() : new Date(ms);
}

/** Test-only; call in BOTH beforeEach AND afterEach to avoid cross-test cache leakage. */
export function _resetAblationCacheForTests(): void {
  _cache = undefined;
}
