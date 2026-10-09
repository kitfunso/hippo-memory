/**
 * Frozen learned memory-value weight vector.
 *
 * GENERATED FROM the frozen artifact
 * (benchmarks/memory-value/weights-learned.json +
 * benchmarks/memory-value/weights-learned.meta.json). NEVER EDIT BY HAND —
 * tests/memory-value-wiring.test.ts's weights-sync test asserts this constant
 * equals the committed JSON artifact (value equality + digest match), so
 * drift between the artifact and this file fails CI.
 *
 * CAVEAT: usage-feature signs reflect an anti-oracle simulation, NOT real usage
 * value. Never read this as production ranking advice.
 */

/** The 8 live feature dims the fitter optimized over (FIT_DIMS). */
export const MEMORY_VALUE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  age_days: -0.3245577821391783,
  half_life_days: 0.11410695580440973,
  strength: -0.06310995260145681,
  retrieval_count: -0.5444761735321539,
  outcome_positive: 0.2334052054621342,
  outcome_negative: 0.37679543146869454,
  outcome_ratio: 0.0770929409760307,
  content_length: -0.6154742645858876,
});

/** sha256 of benchmarks/memory-value/weights-learned.json at freeze time
 *  (weights-learned.meta.json's `weightsFileSha256`). */
export const SOURCE_ARTIFACT_SHA256 =
  '1e747abed0df771fc9c354da8562771b336c4042faf0266f565bba1b5a8c5a40';
