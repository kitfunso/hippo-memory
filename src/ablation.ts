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
 *   HIPPO_ABLATE_RECALL_BOOST  full recall-strengthening ablation:
 *                              - markRetrieved returns entries UNMUTATED (no
 *                                clock reset / count / half-life increment);
 *                                ids stay available so `hippo outcome`
 *                                attribution keeps working in this arm;
 *                              - persisting callers (CLI recall, api context,
 *                                MCP recall/context, consolidation replay)
 *                                skip their writeEntry loops (identical-row
 *                                writes still refresh updated_at / mirrors /
 *                                DAG dirty flags);
 *                              - the retrieval-count READ boost := 1;
 *                              - decay anchors at `created` instead of
 *                                `last_retrieved` (prior-run clock resets
 *                                cannot leak in);
 *                              - physics: computeMass ignores the count, and
 *                                physicsSearch recomputes loaded masses LIVE
 *                                under ablated strength rules (persisted
 *                                masses embed recall history in their frozen
 *                                strength component);
 *                              - replay rehearsal is silenced entirely (it IS
 *                                strengthening; use config replay.count=0 to
 *                                separate replay in unflagged arms).
 *                              CAVEAT: half_life increments persisted by
 *                              prior unflagged runs are NOT reconstructed
 *                              (consolidation legitimately writes half_life
 *                              too) - ablation arms run on FRESH stores, as
 *                              the experiment protocol mandates.
 *   HIPPO_ABLATE_OUTCOME       both outcome channels := neutral
 *                              (= _SLOW + _FAST together). The slow side also
 *                              silences replay's outcome reward bias
 *                              (replayPriority). NOT gated: the opt-in
 *                              `recall --value-aware` rerank (an explicit CLI
 *                              flag that also reads outcome counts) - ablated
 *                              arms must not pass it.
 *   HIPPO_ABLATE_OUTCOME_SLOW  rewardFactor := 1 (no half-life modulation).
 *   HIPPO_ABLATE_OUTCOME_FAST  hybridSearch outcomeBoost := 1.
 *   HIPPO_FAKE_NOW             timestamp injected as the default `now` for
 *                              strength computation and retrieval stamping
 *                              (simulated-time protocols). MUST be the exact
 *                              Date.toISOString() form
 *                              (YYYY-MM-DDTHH:mm:ss.sssZ); validated by
 *                              round-trip, so junk, locale dates, non-UTC
 *                              offsets, and rolled-over dates (2026-02-31)
 *                              all fall back to the real clock.
 *
 * Formula notes (load-bearing for the experiments) - ablating decay has TWO
 * intrinsic co-effects, because the unified formula routes other mechanisms
 * THROUGH the decay term. Both are real properties of the architecture, not
 * implementation accidents; experiment analysis must attribute accordingly
 * (the decay-off arm is "decay + its dependents off", see prereg amendment A1):
 *   1. Read-side strengthening flattens: raw = retrievalBoost * emotionalMult
 *      >= 1, and the [0,1] clamp caps it at 1.0 - the recall boost can only
 *      offset decay, never exceed baseline. (Write-side still runs.)
 *   2. Outcome-slow goes inert: rewardFactor only acts by scaling the
 *      effective half-life INSIDE the decay exponent; with decay := 1 there
 *      is no exponent for it to modulate. Outcome-slow is decay-rate
 *      modulation BY DESIGN, so "no decay" necessarily means "no slow
 *      channel" (the fast channel in hybridSearch is unaffected).
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
    // STRICT canonical form only: exactly what Date.prototype.toISOString
    // emits (YYYY-MM-DDTHH:mm:ss.sssZ), verified by ROUND-TRIP equality.
    // Two codex P2s drove this: (1) Date.parse accepts junk like '1' or
    // locale-dependent '06/11/2026'; (2) a regex alone still admits
    // rolled-over dates ('2026-02-31T...Z' silently becomes March 3). A
    // value that does not round-trip byte-identical falls back to the real
    // clock, exactly as documented.
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
