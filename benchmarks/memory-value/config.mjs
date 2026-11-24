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
  'valence_neutral',
  'valence_positive',
  'valence_negative',
  'valence_critical',
  'layer_buffer',
  'layer_episodic',
  'layer_semantic',
  'layer_trace',
  'kind_raw',
  'kind_distilled',
  'kind_superseded',
  'kind_archived',
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
  age_days: -1,
  outcome_negative: -1,
});

/** Orientation for a feature name; +1 (keep-positive) unless negated above. */
export function orientationOf(feature) {
  return ORIENTATION[feature] ?? 1;
}

export const CONFIG = Object.freeze({
  GLOBAL_SEED: 42,

  TRAIN_FRACTION: 0.6,

  KEEP_BUDGETS: Object.freeze([0.1, 0.2, 0.3, 0.5]),
  PRIMARY_BUDGET: 0.3,

  SIM_ROUNDS: 30,
  SIM_TOP_K: 5,
  SIM_NEGATIVE_EVERY: 3,
  QUERY_MAX_CHARS: 200,
  SIM_SEARCH_BUDGET: 1_000_000,

  E2_BOOTSTRAP_RESAMPLES: 1000,
  E2_PAPER_REFERENCE: Object.freeze({ learned: 0.77, uniform: 0.657, bestSingle: 0.518 }),

  MIN_VARYING_FEATURES: 6,
  MIN_VARYING_FEATURES_SKIP_SIMULATE: 3,

  FEATURES,
  ORIENTATION,
});

export default CONFIG;
