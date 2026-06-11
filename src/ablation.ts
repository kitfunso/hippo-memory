/**
 * EVAL-ONLY lifecycle ablation switches.
 *
 * These env flags exist for controlled experiments on hippo's memory-lifecycle
 * mechanisms (the "lifecycle, ablated" paper protocol): each switch neutralizes
 * exactly ONE mechanism so its causal contribution can be measured in isolation.
 *
 * They are NOT a production configuration surface:
 *   - no config-file equivalents, deliberately (config implies support);
 *   - undocumented in user-facing help;
 *   - semantics may change with the experiment design.
 * Production behavior with all flags unset is byte-identical to before this
 * module existed.
 *
 * Flags (set to '1' or 'true'):
 *   HIPPO_ABLATE_DECAY         time-decay term := 1 in calculateStrength.
 *   HIPPO_ABLATE_RECALL_BOOST  markRetrieved becomes a no-op (all three
 *                              sub-effects: clock reset, retrieval_count,
 *                              half_life increment). NOTE: also neutralizes
 *                              replay rehearsal inside consolidation (same
 *                              helper); use config replay.count=0 to separate
 *                              replay from query-time strengthening.
 *   HIPPO_ABLATE_OUTCOME       both outcome channels := neutral
 *                              (= _SLOW + _FAST together).
 *   HIPPO_ABLATE_OUTCOME_SLOW  rewardFactor := 1 (no half-life modulation).
 *   HIPPO_ABLATE_OUTCOME_FAST  hybridSearch outcomeBoost := 1.
 *   HIPPO_FAKE_NOW             ISO timestamp injected as the default `now`
 *                              for strength computation and retrieval
 *                              stamping (simulated-time protocols). Invalid
 *                              values are ignored (real clock used).
 *
 * Formula note (load-bearing for the experiments): with decay ablated,
 * calculateStrength's raw product is retrievalBoost * emotionalMultiplier,
 * which the [0,1] clamp caps at 1.0 - i.e. the recall-strengthening READ-side
 * boost can only offset decay, never exceed baseline. Ablating decay therefore
 * also flattens the read-side of strengthening (the write-side still runs).
 * This is a real property of the unified formula, not an implementation
 * accident; experiment analysis must account for it.
 *
 * Env caching follows the house pattern (see getLossAversionRatio in
 * memory.ts): read once per process, with a test-only reset helper. Tests
 * that mutate these env vars MUST call _resetAblationCacheForTests() in BOTH
 * beforeEach AND afterEach.
 */

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
    const parsed = Date.parse(rawNow);
    fakeNowMs = Number.isFinite(parsed) ? parsed : null;
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

/**
 * The default `now` for lifecycle computations: HIPPO_FAKE_NOW when set and
 * parseable, else the real clock. Callers that already take an explicit `now`
 * parameter are unaffected (explicit always wins).
 */
export function evalNow(): Date {
  const ms = readFlags().fakeNowMs;
  return ms === null ? new Date() : new Date(ms);
}

/** Test-only. See module JSDoc: call in BOTH beforeEach AND afterEach. */
export function _resetAblationCacheForTests(): void {
  _cache = undefined;
}
