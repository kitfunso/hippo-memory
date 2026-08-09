/**
 * LC2-E1 memory-value eval — single pinned config block.
 *
 * Every protocol number the pre-reg doc quotes lives HERE, exported as one
 * frozen object, so the doc, the harness, and any later audit read the same
 * source of truth. See docs/plans/2026-08-09-lc2-e1-memory-value-eval-substrate.md
 * ("Protocol decisions") for the rationale behind each value.
 *
 * Nothing in this file performs I/O or randomness — it is pure data.
 */

/**
 * Blind feature vector v1 (30 dims after one-hot expansion). Computed by
 * extract.mjs from raw MemoryEntry fields only — never from query text or
 * gold labels. Order here is the canonical iteration order for uniform /
 * single-factor scoring in evaluate.mjs.
 */
export const FEATURES = Object.freeze([
  // Continuous lifecycle scalars
  'age_days',
  'half_life_days',
  'strength',
  'retrieval_count',
  'outcome_positive',
  'outcome_negative',
  'outcome_ratio',
  'schema_fit',
  'pinned',
  'starred',
  'error_tag',
  'tag_count',
  'content_length',
  'dag_level',
  // emotional_valence one-hot (memory.ts EmotionalValence)
  'valence_neutral',
  'valence_positive',
  'valence_negative',
  'valence_critical',
  // layer one-hot (memory.ts Layer)
  'layer_buffer',
  'layer_episodic',
  'layer_semantic',
  'layer_trace',
  // kind one-hot (memory.ts MemoryKind)
  'kind_raw',
  'kind_distilled',
  'kind_superseded',
  'kind_archived',
  // confidence one-hot (memory.ts ConfidenceLevel)
  'confidence_verified',
  'confidence_observed',
  'confidence_inferred',
  'confidence_stale',
]);

/**
 * Explicitly excluded from FEATURES (documented, not just omitted):
 *   - bm25_score: query-derived, would leak the eval question via retrieval.
 *   - anything else keyed off query text or the answer string.
 */
export const EXCLUDED_FEATURES = Object.freeze(['bm25_score']);

/**
 * Sign orientation map (pre-reg "Sign orientation" section). Every feature is
 * oriented keep-positive by default (+1); only the features listed here are
 * negated before the UNIFORM scorer sums them. The error-tag flag is
 * deliberately NOT negated (product semantics: hippo's own deriveHalfLife
 * doubles error-tag half-life because errors are lessons worth keeping).
 *
 * Single-factor baselines in evaluate.mjs evaluate BOTH signs regardless of
 * this map, so an orientation choice here can never hide a better-inverted
 * factor — this map only affects the UNIFORM combiner. The weighted hook
 * ignores it by contract: a --weights file encodes its own signs, and
 * evaluate.mjs applies those weights with no additional orientation multiply.
 */
export const ORIENTATION = Object.freeze({
  age_days: -1, // recency-positive: younger memories score higher
  outcome_negative: -1, // harm-negative: more negative outcomes score lower
});

/** Orientation for a feature name; +1 (keep-positive) unless negated above. */
export function orientationOf(feature) {
  return ORIENTATION[feature] ?? 1;
}

export const CONFIG = Object.freeze({
  // Determinism. Threaded through every seeded RNG in this harness (split's
  // stratified shuffle, run.mjs's --questions subset selection, AND
  // simulate.mjs's query-sampling RNG — codex review fix round, 2026-08-09:
  // simulate.mjs previously hardcoded its RNG seed string with no run seed
  // mixed in, so --seed had zero effect on the usage simulation).
  GLOBAL_SEED: 42,

  // split.mjs
  TRAIN_FRACTION: 0.6,

  // evaluate.mjs keep budgets. PRIMARY_BUDGET carries the E2 bars and the
  // only budget with per-question paired records; the rest are descriptive.
  KEEP_BUDGETS: Object.freeze([0.1, 0.2, 0.3, 0.5]),
  PRIMARY_BUDGET: 0.3,

  // simulate.mjs usage-simulation protocol
  SIM_ROUNDS: 30,
  SIM_TOP_K: 5,
  // Round index r (0-based) gets a NEGATIVE outcome when r % SIM_NEGATIVE_EVERY === 2,
  // POSITIVE otherwise (e.g. rounds 2, 5, 8, ... of every 3 are negative).
  SIM_NEGATIVE_EVERY: 3,
  QUERY_MAX_CHARS: 200,
  // Token budget passed to hybridSearch; deliberately large so it never binds
  // (SIM_TOP_K controls the actual keep count via minResults + slice).
  SIM_SEARCH_BUDGET: 1_000_000,

  // E2 bars (pre-registered now, judged in E2; recorded here so E1's
  // pre-reg doc and E2's fitter quote the identical numbers).
  E2_BOOTSTRAP_RESAMPLES: 1000,
  E2_PAPER_REFERENCE: Object.freeze({ learned: 0.77, uniform: 0.657, bestSingle: 0.518 }),

  // Variance gate (evaluate.mjs computeDatasetVariance / evaluateVarianceGate;
  // codex review fix round, 2026-08-09). MIN_VARYING_FEATURES is the normal
  // (usage-simulated) threshold. MIN_VARYING_FEATURES_SKIP_SIMULATE is the
  // --skip-simulate ablation-specific threshold: without simulation,
  // retrieval_count/outcome_positive/outcome_negative/outcome_ratio/
  // half_life_days are constant BY DESIGN (half_life_days only moves via
  // markRetrieved's +2/retrieval — see ingest.mjs; it needs simulation to
  // vary, same as the outcome/retrieval-count dims), leaving only
  // {age_days, strength, content_length} as naturally-surviving dims —
  // strength still varies because calculateStrength's decay term is a pure
  // function of age even with zero retrievals.
  MIN_VARYING_FEATURES: 6,
  MIN_VARYING_FEATURES_SKIP_SIMULATE: 3,

  FEATURES,
  ORIENTATION,
});

export default CONFIG;
