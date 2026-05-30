/**
 * Core data model for Hippo memory entries.
 * Based on the strength formula from PLAN.md.
 */

import { randomUUID } from 'crypto';

export enum Layer {
  Buffer = 'buffer',
  Episodic = 'episodic',
  Semantic = 'semantic',
  Trace = 'trace',  // ordered action→outcome sequence for RSI
}

export type EmotionalValence = 'neutral' | 'positive' | 'negative' | 'critical';

export type ConfidenceLevel = 'verified' | 'observed' | 'inferred' | 'stale';

export type TraceOutcome = 'success' | 'failure' | 'partial' | null;

export type MemoryKind = 'raw' | 'distilled' | 'superseded' | 'archived';

/**
 * Timestamp invariant.
 *
 * All in-process writes of timestamp fields on `MemoryEntry` (`created`,
 * `last_retrieved`, `valid_from`) and on session-state types (SessionEvent,
 * TaskSnapshot, SessionHandoff, AssembledContextItem.createdAt, etc.) emit
 * canonical `Date.prototype.toISOString()` output: 24 characters, UTC,
 * milliseconds precision, trailing `Z` (e.g. `2026-05-06T09:55:49.123Z`).
 *
 * Caveat — markdown rebuild. `deserializeEntry` / `rebuildIndex` preserve
 * frontmatter timestamp strings as-is. Legacy markdown that recorded a
 * non-canonical offset (e.g. `2026-05-06T05:55:49-04:00`) round-trips
 * through SQLite without normalization, and DAG `earliest_at` / `latest_at`
 * caches are computed from those strings. Importers SHOULD normalize on
 * write; rebuild from drifted markdown is a known limitation.
 *
 * Byte-comparison sort (`<` / `>`) is chronological for any pair of
 * canonical UTC ISO strings. ~50× faster than `localeCompare` with no
 * semantic gain. F4 (v1.6.5) uses byte compare on `assemble`; if a future
 * import path admits non-canonical timestamps, the F4 sort and any
 * downstream chronological reasoning will need a normalization pass.
 */

export interface MemoryEntry {
  id: string;
  created: string;         // ISO 8601
  last_retrieved: string;  // ISO 8601
  retrieval_count: number;
  strength: number;        // 0..1, current computed strength
  half_life_days: number;
  layer: Layer;
  tags: string[];
  emotional_valence: EmotionalValence;
  schema_fit: number;      // 0..1
  source: string;
  outcome_score: number | null;  // null = no feedback yet
  outcome_positive: number;      // cumulative positive outcome count
  outcome_negative: number;      // cumulative negative outcome count
  conflicts_with: string[];
  pinned: boolean;
  confidence: ConfidenceLevel;  // epistemic confidence tier
  content: string;         // the actual memory text
  parents: string[];       // IDs of source memories this was consolidated from (may be empty)
  starred: boolean;        // user-bookmarked
  trace_outcome: TraceOutcome;      // final outcome for trace-layer entries; null otherwise
  source_session_id: string | null; // set by auto-promote; null for everything else
  valid_from: string;               // ISO 8601 timestamp when this belief became true
  superseded_by: string | null;     // ID of the memory that replaced this one; null = current
  extracted_from: string | null;
  dag_level: number;            // 0=leaf, 1=extracted_fact, 2=topic_summary, 3=entity_profile (independent of envelope `kind`)
  dag_parent_id: string | null; // ID of parent summary node in the DAG; null = root level
  // Cached DAG metadata (schema v25). Populated for level-2+ summary rows so
  // recall can reason about scope without re-walking the DAG. Always 0 / null
  // for level-0 leaves and level-1 facts.
  descendant_count?: number;
  earliest_at?: string | null;
  latest_at?: string | null;
  // DAG live-coupling (schema v28, E1 of 5-episode arc).
  /** v28: 1 when this summary row has at least one child invalidated,
   *  superseded, forgotten, or archived since it was last rebuilt. Cleared
   *  by E3's rebuildDirtySummaries during sleep. Always 0 for non-summary
   *  rows (dag_level !== 2; E5 widens to include 3). */
  summary_dirty?: 0 | 1;
  /** v28: ISO 8601 timestamp of the last successful rebuild for this
   *  summary, or null if never rebuilt. */
  last_rebuilt_at?: string | null;
  /** v28: monotonically-increasing counter of successful rebuilds for this
   *  summary. 0 for initial buildDag write; bumped by E3. */
  rebuild_count?: number;
  /** v28 (reserved for E5): ISO 8601 timestamp the level-3 entity profile
   *  was built. Only ever populated on dag_level=3 rows. */
  dag_level_3_built_at?: string | null;
  // A3 provenance envelope (schema v14)
  kind: MemoryKind;             // raw | distilled | superseded | archived
  scope: string | null;         // e.g. 'team:eng', 'project:foo'; null = global
  owner: string | null;         // 'user:<id>' or 'agent:<id>'
  artifact_ref: string | null;  // URI to source artifact (slack://, gh://, file://)
  // A5 stub auth (schema v16)
  tenantId: string;             // 'default' for single-tenant deployments
  /**
   * F1 (v1.7.0): raw SQLite FTS5 bm25() score from the FTS path of
   * `loadSearchEntries`.
   *
   * Populated ONLY when ALL of the following hold:
   *   - `loadSearchEntries` was called with a non-empty query, AND
   *   - FTS5 is available (meta `fts5_available = 1`), AND
   *   - the FTS join returned at least one row (path 2 of `loadSearchRows`).
   *
   * `undefined` on every other path: empty query, FTS unavailable, LIKE
   * fallback, full-store fallback, `readEntry`, `loadAllEntries`, manual
   * upsert, deserializeEntry from markdown.
   *
   * SCALE: FTS5 bm25() is negative; lower = better match (ascending order).
   * NOT a drop-in for the JS-side BM25 in `src/search.ts` — that is a
   * different scorer (different tokenizer, different params, positive
   * scale). Treat `bm25_score` as provenance/rank metadata only.
   */
  bm25_score?: number;
}

export const DECISION_HALF_LIFE_DAYS = 90;

export const INCIDENT_HALF_LIFE_DAYS = 90;

export const PROCESS_HALF_LIFE_DAYS = 90;

export const POLICY_HALF_LIFE_DAYS = 90;

// Emotional multipliers from PLAN.md.
//
// v1.13.5 / J5 loss-aversion calibration (Lovallo-Kahneman TFAS empirics:
// losses ~2x larger than equivalent gains). Defaults rebalanced:
//   - positive (success-tagged): 1.3 -> 1.0
//   - negative (error-tagged):   1.5 -> 2.0
//   - critical stays at 2.0 (literal roadmap reading; J5 silent on critical;
//     ranking signal in consolidate.ts/salience.ts/ambient.ts unchanged)
//   - neutral stays at 1.0
//
// `negative` is further scaled per-process by HIPPO_LOSS_AVERSION_RATIO
// (env var, default 1.0; see getLossAversionRatio + applyLossAversionRatio).
const EMOTIONAL_MULTIPLIERS: Record<EmotionalValence, number> = {
  neutral: 1.0,
  positive: 1.0,
  negative: 2.0,  // error-tagged
  critical: 2.0,
};

/**
 * v1.13.5 / J5 — module-level lazy-cached read of HIPPO_LOSS_AVERSION_RATIO.
 *
 * `calculateStrength` is called per-entry inside hot recall loops
 * (api.ts/consolidate.ts/search.ts), so a per-call `process.env` lookup
 * would multiply N entries by M recalls of lookup cost. Lazy module-cache
 * reads the env ONCE on first call and memoizes for the process lifetime.
 * Test isolation via `_resetLossAversionRatioCacheForTests()` below.
 */

/**
 * v1.13.5 minimum acceptable ratio. Below this, the negative multiplier
 * (2.0 * ratio) becomes small enough that calculateStrength * decay can fall
 * below `DECAY_THRESHOLD = 0.05` in `src/consolidate.ts:146`, which would
 * permanently delete non-pinned error-tagged memories on the next sleep
 * cycle. 0.5 is chosen as the floor because (a) it recovers the v1.13.4
 * effective multiplier (2.0 * 0.5 = 1.0 + the negative premium, i.e. 1.5x
 * the v1.13.4 default), and (b) below this the user is asking for LESS
 * loss aversion than has ever shipped — that's outside the supported
 * tuning range. See codex-review-critic round 1 P1.
 */
const LOSS_AVERSION_RATIO_MIN = 0.5;

/**
 * Validation policy (v1.13.5 + independent-review round-1 HIGH + codex
 * round-1 P1 folds):
 *   - Valid: finite numbers >= 0.5.
 *   - Invalid (silent fallback to 1.0): empty string, non-numeric,
 *     numbers below 0.5 (including 0 and negatives), NaN, +/-Infinity.
 *     Silent because opt-in env vars should not crash production recall
 *     on a typo.
 *
 * Why the 0.5 floor and not 0:
 *   - codex-review-critic round 1 P1: rejecting only `0` (the original
 *     HIGH fold) leaves the same silent data-loss surface for any ratio
 *     below ~0.025 (and worse for aged memories, where even ratio=0.25
 *     can produce strength < DECAY_THRESHOLD = 0.05 in consolidate.ts).
 *     Floor at the v1.13.4-equivalent (0.5) so the env var's tuning
 *     range never crosses into the deletion regime.
 *   - Users wanting LESS loss aversion than v1.13.4's 1.5 multiplier
 *     should reconsider the design intent of J5 (the calibration was
 *     toward MORE loss aversion, not less). If a future use case
 *     genuinely needs ratio < 0.5, the right path is a separate
 *     `HIPPO_NEGATIVE_MULTIPLIER` env override (deferred to J5-v2).
 */
let _lossAversionRatioCache: number | undefined;

function getLossAversionRatio(): number {
  if (_lossAversionRatioCache !== undefined) return _lossAversionRatioCache;
  const raw = process.env.HIPPO_LOSS_AVERSION_RATIO;
  if (raw === undefined || raw === '') {
    _lossAversionRatioCache = 1.0;
    return 1.0;
  }
  const parsed = Number(raw);
  // Finite + >= 0.5 floor. Anything below 0.5 silently falls back to 1.0
  // to avoid the consolidation-deletion vector (see JSDoc above).
  if (!Number.isFinite(parsed) || parsed < LOSS_AVERSION_RATIO_MIN) {
    _lossAversionRatioCache = 1.0;
    return 1.0;
  }
  _lossAversionRatioCache = parsed;
  return parsed;
}

/**
 * Test-only helper. Tests that mutate `process.env.HIPPO_LOSS_AVERSION_RATIO`
 * MUST call this in BOTH `beforeEach` AND `afterEach`:
 *   - beforeEach: clear any stale cache from a previous test before setting
 *     the env var for this test.
 *   - afterEach: clear the cache so the next test (which may not set the env
 *     var) reads the clean default instead of this test's value.
 * See `tests/emotional-multipliers-j5.test.ts` for the canonical pattern.
 */
export function _resetLossAversionRatioCacheForTests(): void {
  _lossAversionRatioCache = undefined;
}

/**
 * Apply the loss-aversion ratio scalar to the `negative` multiplier ONLY.
 * Other valences (positive, critical, neutral) pass through unchanged.
 * `critical` is deliberately NOT scaled: J5 roadmap is silent on critical;
 * its multiplier is left alone so the calibration only touches the
 * specific empirical claim (TFAS 2x losses-vs-gains).
 */
function applyLossAversionRatio(
  valence: EmotionalValence,
  baseMultiplier: number,
): number {
  if (valence !== 'negative') return baseMultiplier;
  return baseMultiplier * getLossAversionRatio();
}

/**
 * Compute the reward factor from cumulative outcome counts.
 *
 *   reward_ratio  = (positive - negative) / (positive + negative + 1)
 *   reward_factor = 1 + 0.5 * reward_ratio
 *
 * Range: (0.5, 1.5). Neutral (no outcomes) returns 1.0.
 * Modulates effective half-life: memories with consistent positive outcomes
 * decay slower; consistent negative outcomes decay faster.
 */
export function calculateRewardFactor(entry: MemoryEntry): number {
  const pos = entry.outcome_positive ?? 0;
  const neg = entry.outcome_negative ?? 0;
  if (pos === 0 && neg === 0) return 1.0;
  const ratio = (pos - neg) / (pos + neg + 1);
  return 1 + 0.5 * ratio;
}

/**
 * Options for decay basis.
 * - clock: wall-clock time (default pre-v0.15)
 * - session: decay by sleep cycle count (for intermittent agents)
 * - adaptive: auto-scale half-life by session frequency (default v0.15+)
 */
export interface DecayOptions {
  decayBasis?: 'clock' | 'session' | 'adaptive';
  /** Average interval between sleep cycles, in days. Used by 'adaptive' and 'session' modes. */
  avgSessionIntervalDays?: number;
  /** Total sleep cycles completed. Used by consolidation tracking. */
  sleepCount?: number;
}

/**
 * Calculate current strength at a given time.
 * strength(t) = base_strength * decay * retrieval_boost * emotional_multiplier
 *
 * Decay basis modes:
 * - clock: classic wall-clock decay (daysSince / halfLife)
 * - session: decay by sleep cycles instead of days (sessionsSince / halfLife)
 * - adaptive: wall-clock decay with half-life scaled by session frequency
 *
 * Pinned memories always return 1.0 (no decay).
 */
export function calculateStrength(
  entry: MemoryEntry,
  now: Date = new Date(),
  options: DecayOptions = {},
): number {
  if (entry.pinned) return 1.0;

  const lastRetrieved = new Date(entry.last_retrieved);
  const daysSince = (now.getTime() - lastRetrieved.getTime()) / (1000 * 60 * 60 * 24);

  // Reward-proportional half-life modulation
  const rewardFactor = calculateRewardFactor(entry);
  let effectiveHalfLife = entry.half_life_days * rewardFactor;

  // Guard: zero half-life causes 0/0 = NaN in the exponent
  if (effectiveHalfLife <= 0) return 0.0;

  const basis = options.decayBasis ?? 'clock';
  let decayExponent: number;

  if (basis === 'session') {
    // Decay by session count: each sleep cycle = 1 "day" in the decay formula.
    // Estimate sessions since last retrieval from wall-clock time and avg interval.
    const avgInterval = options.avgSessionIntervalDays ?? 1;
    const sessionsSince = avgInterval > 0 ? Math.max(0, daysSince / avgInterval) : daysSince;
    decayExponent = sessionsSince / effectiveHalfLife;
  } else if (basis === 'adaptive') {
    // Scale half-life by session frequency: infrequent agents get longer half-lives
    const avgInterval = options.avgSessionIntervalDays ?? 0;
    if (avgInterval > 1) {
      effectiveHalfLife *= avgInterval;
    }
    decayExponent = daysSince / effectiveHalfLife;
  } else {
    // clock: classic wall-clock decay
    decayExponent = daysSince / effectiveHalfLife;
  }

  const decay = Math.pow(0.5, decayExponent);

  // Retrieval boost: 1 + 0.1 * log2(retrieval_count + 1)
  const retrievalBoost = 1 + 0.1 * Math.log2(entry.retrieval_count + 1);

  // Emotional multiplier
  // v1.13.5 / J5: apply HIPPO_LOSS_AVERSION_RATIO to the negative multiplier
  // ONLY (positive/critical/neutral pass through unchanged). Lazy module-cache
  // means this is a single Map lookup + one numeric multiply, not a per-call
  // process.env read.
  const baseMultiplier = EMOTIONAL_MULTIPLIERS[entry.emotional_valence] ?? 1.0;
  const emotionalMultiplier = applyLossAversionRatio(entry.emotional_valence, baseMultiplier);

  const raw = decay * retrievalBoost * emotionalMultiplier;

  // Clamp to [0, 1] with NaN guard
  const clamped = Math.min(1.0, Math.max(0.0, raw));
  return Number.isFinite(clamped) ? clamped : 0.0;
}

/**
 * Derive half-life based on signals, as per PLAN.md table.
 */
export function deriveHalfLife(base: number, entry: Partial<MemoryEntry>): number {
  let hl = base;

  // Error-tagged: 2x half-life
  if (entry.tags?.includes('error')) {
    hl *= 2;
  }

  // High schema fit: consolidates faster (1.5x)
  if (entry.schema_fit !== undefined && entry.schema_fit > 0.7) {
    hl *= 1.5;
  }

  // Low schema fit: decay faster (0.5x)
  if (entry.schema_fit !== undefined && entry.schema_fit < 0.3) {
    hl *= 0.5;
  }

  return hl;
}

/**
 * Apply outcome feedback to a memory entry.
 *
 * Increments outcome_positive or outcome_negative counters.
 * The reward factor in calculateStrength() uses these counts to
 * continuously modulate the effective half-life:
 *   reward_ratio  = (pos - neg) / (pos + neg + 1)
 *   reward_factor = 1 + 0.5 * reward_ratio    // range (0.5, 1.5)
 *   effective_hl  = half_life_days * reward_factor
 *
 * No fixed half-life delta. Decay rate adjusts proportionally to
 * cumulative reward signal, inspired by R-STDP in spiking networks.
 */
export function applyOutcome(entry: MemoryEntry, good: boolean): MemoryEntry {
  const updated: MemoryEntry = {
    ...entry,
    outcome_score: good ? 1 : -1,
    outcome_positive: (entry.outcome_positive ?? 0) + (good ? 1 : 0),
    outcome_negative: (entry.outcome_negative ?? 0) + (good ? 0 : 1),
  };
  updated.strength = calculateStrength(updated);
  return updated;
}

/**
 * Generate a random memory ID using crypto.randomUUID().
 */
export function generateId(prefix: string = 'mem'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Resolve the effective confidence for a memory entry.
 * If the entry has not been retrieved in 30+ days and is not 'verified',
 * returns 'stale'. Otherwise returns the stored confidence value.
 */
export function resolveConfidence(entry: MemoryEntry, now: Date = new Date()): ConfidenceLevel {
  if (entry.pinned || entry.confidence === 'verified') return entry.confidence;

  const lastRetrieved = new Date(entry.last_retrieved);
  const daysSince = (now.getTime() - lastRetrieved.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSince > 30) return 'stale';
  return entry.confidence;
}

/**
 * Create a new memory entry with defaults.
 */
export function createMemory(
  content: string,
  options: {
    layer?: Layer;
    tags?: string[];
    emotional_valence?: EmotionalValence;
    pinned?: boolean;
    schema_fit?: number;
    source?: string;
    confidence?: ConfidenceLevel;
    baseHalfLifeDays?: number;
    trace_outcome?: TraceOutcome;
    source_session_id?: string | null;
    valid_from?: string;
    extracted_from?: string;
    dag_level?: number;
    dag_parent_id?: string;
    kind?: MemoryKind;
    scope?: string | null;
    owner?: string | null;
    artifact_ref?: string | null;
    tenantId?: string;
  } = {}
): MemoryEntry {
  const trimmed = content.trim();
  if (trimmed.length < 3) {
    throw new Error(`Memory content too short (${trimmed.length} chars, minimum 3): "${trimmed}"`);
  }

  const validOutcomes: (string | null)[] = ['success', 'failure', 'partial', null];
  if (options.trace_outcome !== undefined && !validOutcomes.includes(options.trace_outcome)) {
    throw new Error(`Invalid trace_outcome: ${options.trace_outcome}. Must be 'success', 'failure', 'partial', or null.`);
  }

  const now = new Date().toISOString();
  const layer = options.layer ?? Layer.Episodic;
  const tags = options.tags ?? [];
  const emotional_valence = options.emotional_valence ?? inferValence(tags);
  const schema_fit = options.schema_fit ?? 0.5;

  const partial: Partial<MemoryEntry> = { tags, schema_fit };
  const half_life_days = deriveHalfLife(options.baseHalfLifeDays ?? 7, partial);

  const entry: MemoryEntry = {
    id: generateId(layer === Layer.Semantic ? 'sem' : 'mem'),
    created: now,
    last_retrieved: now,
    retrieval_count: 0,
    strength: 1.0,
    half_life_days,
    layer,
    tags,
    emotional_valence,
    schema_fit,
    source: options.source ?? 'cli',
    outcome_score: null,
    outcome_positive: 0,
    outcome_negative: 0,
    conflicts_with: [],
    pinned: options.pinned ?? false,
    confidence: options.confidence ?? 'verified',
    content,
    parents: [],
    starred: false,
    trace_outcome: options.trace_outcome ?? null,
    source_session_id: options.source_session_id ?? null,
    valid_from: options.valid_from ?? now,
    superseded_by: null,
    extracted_from: options.extracted_from ?? null,
    dag_level: options.dag_level ?? 0,
    dag_parent_id: options.dag_parent_id ?? null,
    kind: options.kind ?? 'distilled',
    scope: options.scope ?? null,
    owner: options.owner ?? null,
    artifact_ref: options.artifact_ref ?? null,
    tenantId: options.tenantId ?? 'default',
  };

  // Recalculate strength with the emotional multiplier applied
  entry.strength = calculateStrength(entry);
  return entry;
}

/**
 * Compute how well new content fits existing knowledge patterns.
 * Returns 0..1 where:
 *   >0.7 = high fit (consistent with existing knowledge, consolidates faster)
 *   0.3-0.7 = moderate fit
 *   <0.3 = novel (doesn't match existing patterns, decays faster if unused)
 *
 * Uses tag overlap (always available) weighted by how common each tag is.
 * Rare shared tags signal stronger schema fit than common ones.
 */
export function computeSchemaFit(
  content: string,
  tags: string[],
  existingEntries: MemoryEntry[]
): number {
  if (existingEntries.length === 0) return 0.5; // no schema yet, neutral

  // Build tag frequency map across all existing entries
  const tagFreq = new Map<string, number>();
  for (const entry of existingEntries) {
    for (const tag of entry.tags) {
      tagFreq.set(tag, (tagFreq.get(tag) ?? 0) + 1);
    }
  }

  if (tags.length === 0 && tagFreq.size === 0) return 0.5;

  // Tag overlap: IDF-weighted Jaccard
  // Shared rare tags matter more than shared common tags
  let weightedOverlap = 0;
  let totalWeight = 0;
  const N = existingEntries.length;

  for (const tag of tags) {
    const freq = tagFreq.get(tag) ?? 0;
    // IDF-weighted: rare shared tags score higher
    const maxIdf = Math.log(N + 1) + 1;

    if (freq > 0) {
      const idf = Math.log(N / freq) + 1;
      weightedOverlap += idf;
    }
    totalWeight += maxIdf;
  }

  // Scale so that matching half the tags at average IDF gives ~0.5
  const tagScore = totalWeight > 0 ? Math.min(1, (weightedOverlap / totalWeight) * 2) : 0;

  // Content overlap: check how many existing entries share significant tokens
  const newTokens = new Set(
    content.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((t) => t.length > 3)
  );

  if (newTokens.size === 0) return Math.min(1, Math.max(0, tagScore));

  let contentMatches = 0;
  for (const entry of existingEntries) {
    const entryTokens = new Set(
      entry.content.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((t) => t.length > 3)
    );
    let shared = 0;
    for (const token of newTokens) {
      if (entryTokens.has(token)) shared++;
    }
    const overlap = shared / Math.max(newTokens.size, 1);
    if (overlap > 0.2) contentMatches++;
  }

  const contentScore = Math.min(1, contentMatches / Math.max(5, N * 0.1));

  // Blend: 60% tag overlap, 40% content overlap
  const fit = 0.6 * tagScore + 0.4 * contentScore;
  return Math.min(1, Math.max(0, fit));
}

function inferValence(tags: string[]): EmotionalValence {
  if (tags.includes('critical')) return 'critical';
  if (tags.includes('error')) return 'negative';
  if (tags.includes('success') || tags.includes('win')) return 'positive';
  return 'neutral';
}
