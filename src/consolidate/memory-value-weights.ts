/** Frozen learned memory-value weight vector, GENERATED from benchmarks/memory-value/weights-learned.json; never edit by hand (a sync test fails CI on drift).
 * CAVEAT: usage-feature signs come from an anti-oracle simulation, not real usage value; never read this as production ranking advice. */

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
