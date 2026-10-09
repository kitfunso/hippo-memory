/**
 * Core data model for Hippo memory entries.
 * Based on the strength formula from PLAN.md.
 */

import { envLossAversionRatio } from '../util/env.js';
import { BadRequestError } from './api-errors.js';
import { randomUUID } from 'crypto';
import {
  isDecayAblated,
  isOutcomeSlowAblated,
  isRecallBoostAblated,
  evalNow,
} from './ablation.js';
import { AGENT_MEMORY_TOOLS, toolSourcePrefix } from './agent-memory-tools.js';
import { DAY_MS } from '../util/time.js';
import { ID_SUFFIX_CHARS } from '../util/token-text.js';
export const DEFAULT_SCHEMA_FIT = 0.5;
export const FALLBACK_HALF_LIFE_DAYS = 7;

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
 * semantic gain. `assemble` sorts by byte compare; if a future
 * import path admits non-canonical timestamps, that sort and any
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
  source_session_id: string | null; // set by auto-promote and session digests; null for everything else
  valid_from: string;               // ISO 8601 timestamp when this belief became true
  superseded_by: string | null;     // ID of the memory that replaced this one; null = current
  extracted_from: string | null;
  dag_level: number;            // 0=leaf, 1=extracted_fact, 2=topic_summary, 3=entity_profile (independent of envelope `kind`)
  dag_parent_id: string | null; // ID of parent summary node in the DAG; null = root level
  // Cached DAG metadata. Populated for level-2+ summary rows so
  // recall can reason about scope without re-walking the DAG. Always 0 / null
  // for level-0 leaves and level-1 facts.
  descendant_count?: number;
  earliest_at?: string | null;
  latest_at?: string | null;
  // DAG live-coupling.
  /** 1 when this summary row has at least one child invalidated,
   *  superseded, forgotten, or archived since it was last rebuilt. Cleared
   *  by rebuildDirtySummaries during sleep. Always 0 for non-summary
   *  rows (dag_level !== 2). */
  summary_dirty?: 0 | 1;
  /** ISO 8601 timestamp of the last successful rebuild for this
   *  summary, or null if never rebuilt. */
  last_rebuilt_at?: string | null;
  /** Monotonically-increasing counter of successful rebuilds for this
   *  summary. 0 for initial buildDag write; bumped by each rebuild. */
  rebuild_count?: number;
  /** Reserved: ISO 8601 timestamp the level-3 entity profile
   *  was built. Only ever populated on dag_level=3 rows. */
  dag_level_3_built_at?: string | null;
  // Provenance envelope
  kind: MemoryKind;             // raw | distilled | superseded | archived
  scope: string | null;         // e.g. 'team:eng', 'project:foo'; null = global
  owner: string | null;         // 'user:<id>' or 'agent:<id>'
  artifact_ref: string | null;  // URI to source artifact (slack://, gh://, file://)
  // Stub auth
  tenantId: string;             // 'default' for single-tenant deployments
  /**
   * Memory scope isolation: owning project for ambient-context
   * partitioning. A lowercased project name, '' for user-global (injectable
   * everywhere), or null for no known project (a legacy row, or a shared-store
   * write that named none) - ambient context treats null as other-project (deny).
   * Stamped at write time by store/entry-row.ts stampOriginProject via fallbackOrigin;
   * undefined only on entries not yet written.
   */
  origin_project?: string | null;
  /**
   * Raw SQLite FTS5 bm25() score from the FTS path of
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

/** Tag on a memory whose named file/symbol/script changed after it was stored. */
export const CHURN_STALE_TAG = 'churn-stale';

// Emotional multipliers from PLAN.md. Losses weigh ~2x equivalent gains (Lovallo-Kahneman TFAS empirics),
// so negative is 2.0. `negative` is further scaled per-process by HIPPO_LOSS_AVERSION_RATIO
// (env var, default 1.0; see getLossAversionRatio + applyLossAversionRatio).
export const EMOTIONAL_MULTIPLIERS = {
  neutral: 1.0,
  positive: 1.0,
  negative: 2.0,  // error-tagged
  critical: 2.0,
} satisfies Record<EmotionalValence, number>;

/**
 * Module-level lazy-cached read of HIPPO_LOSS_AVERSION_RATIO.
 *
 * `calculateStrength` is called per-entry inside hot recall loops
 * (api.ts/consolidate.ts/search.ts), so a per-call `process.env` lookup
 * would multiply N entries by M recalls of lookup cost. Lazy module-cache
 * reads the env ONCE on first call and memoizes for the process lifetime.
 * Test isolation via `_resetLossAversionRatioCacheForTests()` below.
 */

/**
 * Minimum acceptable ratio. Below this, the negative multiplier
 * (2.0 * ratio) becomes small enough that calculateStrength * decay can fall
 * below `DECAY_THRESHOLD = 0.05` in `src/consolidate.ts:146`, which would
 * permanently delete non-pinned error-tagged memories on the next sleep
 * cycle. 0.5 is chosen as the floor because (a) it recovers the pre-calibration
 * effective multiplier (2.0 * 0.5 = 1.0 + the negative premium, i.e. 1.5x
 * the pre-calibration default), and (b) below this the user is asking for LESS
 * loss aversion than has ever shipped — that's outside the supported
 * tuning range.
 */
const LOSS_AVERSION_RATIO_MIN = 0.5;

/**
 * Validation policy:
 *   - Valid: finite numbers >= 0.5.
 *   - Invalid (silent fallback to 1.0): empty string, non-numeric,
 *     numbers below 0.5 (including 0 and negatives), NaN, +/-Infinity.
 *     Silent because opt-in env vars should not crash production recall
 *     on a typo.
 *
 * Why the 0.5 floor and not 0:
 *   - Rejecting only `0` leaves the same silent data-loss surface for any ratio
 *     below ~0.025 (and worse for aged memories, where even ratio=0.25
 *     can produce strength < DECAY_THRESHOLD = 0.05 in consolidate.ts).
 *     Floor at the pre-calibration equivalent (0.5) so the env var's tuning
 *     range never crosses into the deletion regime.
 *   - Users wanting LESS loss aversion than the pre-calibration 1.5 multiplier
 *     should reconsider the design intent (the calibration was
 *     toward MORE loss aversion, not less). If a future use case
 *     genuinely needs ratio < 0.5, the right path is a separate
 *     `HIPPO_NEGATIVE_MULTIPLIER` env override.
 */
let _lossAversionRatioCache: number | undefined;

function getLossAversionRatio(): number {
  if (_lossAversionRatioCache !== undefined) return _lossAversionRatioCache;
  const raw = envLossAversionRatio();
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
 * See `tests/emotional-multipliers.test.ts` for the pattern.
 */
export function _resetLossAversionRatioCacheForTests(): void {
  _lossAversionRatioCache = undefined;
}

/**
 * Apply the loss-aversion ratio scalar to the `negative` multiplier ONLY.
 * Other valences (positive, critical, neutral) pass through unchanged.
 * `critical` is deliberately NOT scaled, so the calibration only touches the
 * specific empirical claim (TFAS 2x losses-vs-gains).
 */
export function applyLossAversionRatio(
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
export function calculateRewardFactor(entry: Pick<MemoryEntry, 'outcome_positive' | 'outcome_negative'>): number {
  // EVAL-ONLY ablation (see ablation.ts): the slow outcome channel.
  if (isOutcomeSlowAblated()) return 1.0;
  const pos = entry.outcome_positive ?? 0;
  const neg = entry.outcome_negative ?? 0;
  if (pos === 0 && neg === 0) return 1.0;
  const ratio = (pos - neg) / (pos + neg + 1);
  return 1 + REWARD_SLOPE * ratio;
}

/** Bad marks alone never push a memory under sleep's 0.05 retire line; supersede is the hard correction. */
export const MAX_WRONG_HALVINGS = 3;

// Shared by calculateStrength and strengthSql (src/store/rule-sql.ts) so the two cannot drift.
export const DECAY_BASE = 0.5;
export const REWARD_SLOPE = 0.5;
export const RETRIEVAL_BOOST_SLOPE = 0.1;

/**
 * Net wrongness: bad outcome marks past good ones, never below zero.
 * Strength halves per unit (capped at 3) and recall stops strengthening
 * the memory, so a correction outranks pinning, error tags and heavy recall.
 */
export function netWrong(entry: Pick<MemoryEntry, 'outcome_positive' | 'outcome_negative'>): number {
  if (isOutcomeSlowAblated() || isDecayAblated()) return 0;
  return Math.max(0, (entry.outcome_negative ?? 0) - (entry.outcome_positive ?? 0));
}

/**
 * Options for decay basis.
 * - clock: wall-clock time (former default)
 * - session: decay by sleep cycle count (for intermittent agents)
 * - adaptive: auto-scale half-life by session frequency (default)
 */
/** What calculateStrength reads, so a caller can score a row without loading its text. */
export type StrengthInputs = Pick<
  MemoryEntry,
  'pinned' | 'created' | 'last_retrieved' | 'half_life_days' | 'retrieval_count' | 'emotional_valence' | 'outcome_positive' | 'outcome_negative'
>;

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
 * Pinned memories skip time decay; being marked wrong still fades them (netWrong).
 */
export function calculateStrength(
  entry: StrengthInputs,
  // evalNow(): the real clock unless HIPPO_FAKE_NOW is set (eval-only,
  // simulated-time protocols; see ablation.ts). Explicit `now` always wins.
  now: Date = evalNow(),
  options: DecayOptions = {},
): number {
  // Being marked wrong outranks every shield: pinning, error tags, heavy recall.
  const wrongPenalty = Math.pow(DECAY_BASE, Math.min(netWrong(entry), MAX_WRONG_HALVINGS));
  if (entry.pinned) return wrongPenalty;

  // EVAL-ONLY ablation (see ablation.ts): anchor decay at CREATION, so clock resets persisted by PRIOR
  // unflagged runs cannot leak strengthening into an ablated arm. Prior-run half_life increments are
  // NOT reconstructed - see the ablation.ts caveat (fresh stores per arm).
  const lastRetrieved = new Date(
    isRecallBoostAblated() ? entry.created : entry.last_retrieved,
  );
  const daysSince = (now.getTime() - lastRetrieved.getTime()) / DAY_MS;

  // Reward-proportional half-life modulation
  const rewardFactor = calculateRewardFactor(entry);
  const effectiveHalfLife = entry.half_life_days * rewardFactor;

  // Guard: zero half-life causes 0/0 = NaN in the exponent
  if (effectiveHalfLife <= 0) return 0.0;

  const decayExponent = decayExponentFor(options, daysSince, effectiveHalfLife);

  // EVAL-ONLY ablation (see ablation.ts): decay term := 1. NOTE the [0,1]
  // clamp below then caps retrievalBoost at baseline - see ablation.ts
  // formula note.
  const decay = isDecayAblated() ? 1.0 : Math.pow(DECAY_BASE, decayExponent);

  const retrievalBoost = retrievalBoostFor(entry);

  // Emotional multiplier. HIPPO_LOSS_AVERSION_RATIO scales the negative one ONLY; the lazy
  // module cache makes this one lookup + one multiply, not a per-call process.env read.
  const baseMultiplier = EMOTIONAL_MULTIPLIERS[entry.emotional_valence] ?? 1.0;
  const emotionalMultiplier = applyLossAversionRatio(entry.emotional_valence, baseMultiplier);

  const raw = decay * retrievalBoost * emotionalMultiplier;

  // Clamp to [0, 1] with NaN guard
  const clamped = Math.min(1.0, Math.max(0.0, raw));
  return Number.isFinite(clamped) ? clamped * wrongPenalty : 0.0;
}

function decayExponentFor(options: DecayOptions, daysSince: number, halfLifeDays: number): number {
  let effectiveHalfLife = halfLifeDays;
  const basis = options.decayBasis ?? 'clock';
  if (basis === 'session') {
    // Decay by session count: each sleep cycle = 1 "day" in the decay formula.
    // Estimate sessions since last retrieval from wall-clock time and avg interval.
    const avgInterval = options.avgSessionIntervalDays ?? 1;
    const sessionsSince = avgInterval > 0 ? Math.max(0, daysSince / avgInterval) : daysSince;
    return sessionsSince / effectiveHalfLife;
  }
  if (basis === 'adaptive') {
    // Scale half-life by session frequency: infrequent agents get longer half-lives
    const avgInterval = options.avgSessionIntervalDays ?? 0;
    if (avgInterval > 1) {
      effectiveHalfLife *= avgInterval;
    }
    return daysSince / effectiveHalfLife;
  }
  // clock: classic wall-clock decay
  return daysSince / effectiveHalfLife;
}

// Retrieval boost: 1 + 0.1 * log2(retrieval_count + 1). EVAL-ONLY ablation (see ablation.ts) neutralizes
// the READ side too, so counts written before the flag cannot leak strengthening into an ablated arm.
function retrievalBoostFor(entry: StrengthInputs): number {
  return isRecallBoostAblated() || netWrong(entry) > 0
    ? 1.0
    : 1 + RETRIEVAL_BOOST_SLOPE * Math.log2(entry.retrieval_count + 1);
}

/**
 * Derive half-life based on signals, as per PLAN.md table.
 */
const HIGH_SCHEMA_FIT = 0.7;
const HIGH_FIT_HALF_LIFE_FACTOR = 1.5;
const LOW_SCHEMA_FIT = 0.3;
const LOW_FIT_HALF_LIFE_FACTOR = 0.5;
// Schema fit blends tag coverage and content similarity; a content match needs this share of shared tokens.
const TAG_FIT_WEIGHT = 0.6;
const CONTENT_FIT_WEIGHT = 0.4;
const CONTENT_TOKEN_SHARE_MIN = 0.2;
const CONTENT_ENOUGH_FRACTION = 0.1;

export function deriveHalfLife(base: number, entry: Partial<MemoryEntry>): number {
  let hl = base;

  // Error-tagged: 2x half-life
  if (entry.tags?.includes('error')) {
    hl *= 2;
  }

  // High schema fit: consolidates faster (1.5x)
  if (entry.schema_fit !== undefined && entry.schema_fit > HIGH_SCHEMA_FIT) {
    hl *= HIGH_FIT_HALF_LIFE_FACTOR;
  }

  // Low schema fit: decay faster (0.5x)
  if (entry.schema_fit !== undefined && entry.schema_fit < LOW_SCHEMA_FIT) {
    hl *= LOW_FIT_HALF_LIFE_FACTOR;
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

/** applyOutcome as a served outcome applies it: a good outcome reconfirms the entry, so its churn-stale tag goes. */
export function entryAfterOutcome(entry: MemoryEntry, good: boolean): MemoryEntry {
  const updated = applyOutcome(entry, good);
  if (!good || !updated.tags.includes(CHURN_STALE_TAG)) return updated;
  return { ...updated, tags: updated.tags.filter((t) => t !== CHURN_STALE_TAG) };
}

/**
 * Generate a random memory ID using crypto.randomUUID().
 */
export function generateId(prefix: string = 'mem'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, ID_SUFFIX_CHARS)}`;
}

// Pinned and verified are exempt from ageing by policy, so this reads "aged out
// for trust purposes", not "old". The 30-day threshold lives here and nowhere else.
/** What the confidence facets read, so a caller can derive them from a row it loaded only in part. */
export type ConfidenceInputs = Pick<MemoryEntry, 'pinned' | 'confidence' | 'last_retrieved'>;

function isAgedOut(entry: ConfidenceInputs, now: Date): boolean {
  if (entry.pinned || entry.confidence === 'verified') return false;
  const lastRetrieved = new Date(entry.last_retrieved);
  return (now.getTime() - lastRetrieved.getTime()) / DAY_MS > 30;
}

export interface ConfidenceFacets {
  // Stored: why we believe the entry. Derived: nobody retrieved it lately.
  tier: ConfidenceLevel;
  agedOut: boolean;
}

export function confidenceFacets(entry: MemoryEntry, now: Date = evalNow()): ConfidenceFacets {
  return facetsOf(entry, now);
}

export function facetsOf(entry: ConfidenceInputs, now: Date): ConfidenceFacets {
  return { tier: entry.confidence, agedOut: isAgedOut(entry, now) };
}

// `warn` covers exactly the rows the old collapsed-value rule did: an aged-out row
// used to read 'stale', so warning on it separately keeps the same set.
export function confidenceLabel(entry: MemoryEntry, now: Date = evalNow()): { text: string; warn: boolean } {
  const { tier, agedOut } = confidenceFacets(entry, now);
  return {
    text: agedOut ? `${tier}, aged` : tier,
    warn: agedOut || tier === 'stale' || tier === 'inferred',
  };
}

/**
 * Resolve the effective confidence for a memory entry.
 * If the entry has not been retrieved in 30+ days and is not 'verified',
 * returns 'stale'. Otherwise returns the stored confidence value.
 */
export function resolveConfidence(entry: MemoryEntry, now: Date = evalNow()): ConfidenceLevel {
  return isAgedOut(entry, now) ? 'stale' : entry.confidence;
}

/**
 * Base half-life for a new memory, in days, before `deriveHalfLife`'s
 * write-time multipliers. 365 because 7 days lost the current fact far more
 * often, and 730 days or no decay did no better. `hippo sleep` moves memories still
 * on an older base (src/consolidate/half-life-migration.ts).
 */
export const DEFAULT_HALF_LIFE_DAYS = 365;

export const COMPACTION_MEMORY_TAG = 'compaction-memory';
export const COMPACTION_SOURCE_PREFIX = 'compaction:';

/** An imported agent memory (its tool's tag, and a source starting that tool's prefix) is kept for good: the agent's note file is its record. Both, since merge copies source tags onto rows whose source is 'consolidation'. */
export interface KeepPair {
  readonly tag: string;
  readonly sourcePrefix: string;
}
export const KEEP_PAIRS: readonly KeepPair[] = AGENT_MEMORY_TOOLS.map((t) => ({ tag: t.tag, sourcePrefix: toolSourcePrefix(t.id) }));

export function isKeptForGood(entry: Pick<MemoryEntry, 'tags' | 'source' | 'superseded_by'>): boolean {
  return !entry.superseded_by && KEEP_PAIRS.some((p) => entry.tags.includes(p.tag) && entry.source.startsWith(p.sourcePrefix));
}
export function canAutoDelete(entry: Pick<MemoryEntry, 'pinned' | 'kind' | 'tags' | 'source' | 'superseded_by'>): boolean {
  return !entry.pinned && entry.kind !== 'raw' && !isKeptForGood(entry);
}

export interface CreateMemoryOptions {
  layer?: Layer;
  tags?: string[];
  emotional_valence?: EmotionalValence;
  pinned?: boolean;
  schema_fit?: number;
  source?: string;
  confidence?: ConfidenceLevel;
  /** The store's `loadConfig(hippoRoot).defaultHalfLifeDays`; required so no writer falls back to the compiled default by leaving it out. */
  baseHalfLifeDays: number;
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
}

/** Create a new memory entry with defaults. Untyped JavaScript callers that omit the options get the compiled default half-life. */
export function createMemory(content: string, options: CreateMemoryOptions): MemoryEntry;
export function createMemory(content: string, options: Partial<CreateMemoryOptions> = {}): MemoryEntry {
  assertValidMemoryInput(content, options);

  const now = evalNow().toISOString(); // honors HIPPO_FAKE_NOW (eval-only)
  const layer = options.layer ?? Layer.Episodic;
  const tags = options.tags ?? [];
  const emotional_valence = options.emotional_valence ?? inferValence(tags);
  const schema_fit = options.schema_fit ?? DEFAULT_SCHEMA_FIT;

  const half_life_days = deriveHalfLife(options.baseHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS, { tags, schema_fit });

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

function assertValidMemoryInput(content: string, options: Partial<CreateMemoryOptions>): void {
  const trimmed = content.trim();
  if (trimmed.length < 3) {
    throw new BadRequestError(`Memory content too short (${trimmed.length} chars, minimum 3): "${trimmed}"`);
  }

  const validOutcomes: (string | null)[] = ['success', 'failure', 'partial', null];
  if (options.trace_outcome !== undefined && !validOutcomes.includes(options.trace_outcome)) {
    throw new BadRequestError(`Invalid trace_outcome: ${options.trace_outcome}. Must be 'success', 'failure', 'partial', or null.`);
  }
}

/** The row that replaces `old`: a supersede never changes where a memory belongs, so source, scope, session and a stamped origin carry over. */
export function createSuccessor(
  old: MemoryEntry,
  content: string,
  opts: { tenantId: string; baseHalfLifeDays: number; layer?: Layer; tags?: string[]; pinned?: boolean },
): MemoryEntry {
  const next = createMemory(content, {
    layer: opts.layer ?? old.layer,
    tags: opts.tags ?? [...old.tags],
    pinned: opts.pinned ?? old.pinned,
    source: old.source,
    confidence: 'verified',
    tenantId: opts.tenantId,
    scope: old.scope,
    source_session_id: old.source_session_id,
    baseHalfLifeDays: opts.baseHalfLifeDays,
  });
  // A legacy null origin has nothing to carry, so the store stamps it from its own location.
  if (typeof old.origin_project === 'string') {
    next.origin_project = old.origin_project;
  }
  return next;
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
  const tagCounts = new Map<string, number>();
  for (const entry of existingEntries) {
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return schemaFitFrom(content, tags, { rows: existingEntries.length, tagCounts, contents: existingEntries.map((e) => e.content) });
}

/** What schema fit reads from a set of memories, so a store can answer without loading its rows. */
export interface SchemaFitSource {
  readonly rows: number;
  /** How many times each tag appears across the set. */
  readonly tagCounts: ReadonlyMap<string, number>;
  /** Each memory's text; the walk stops once more matches cannot move the score. */
  readonly contents: Iterable<string>;
}

function significantTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((t) => t.length > 3));
}

/** computeSchemaFit against `source`, for a caller that holds counts and texts but no rows. */
export function schemaFitFrom(content: string, tags: readonly string[], source: SchemaFitSource): number {
  const N = source.rows;
  if (N === 0) return 0.5; // no schema yet, neutral
  const tagFreq = source.tagCounts;
  if (tags.length === 0 && tagFreq.size === 0) return 0.5;

  // Tag overlap, weighted so a shared rare tag counts for more than a shared common one.
  let weightedOverlap = 0;
  let totalWeight = 0;
  const maxIdf = Math.log(N + 1) + 1;
  for (const tag of tags) {
    const freq = tagFreq.get(tag) ?? 0;
    if (freq > 0) weightedOverlap += Math.log(N / freq) + 1;
    totalWeight += maxIdf;
  }
  // Scaled so that matching half the tags at average weight gives about 0.5.
  const tagScore = totalWeight > 0 ? Math.min(1, (weightedOverlap / totalWeight) * 2) : 0;

  const newTokens = significantTokens(content);
  if (newTokens.size === 0) return Math.min(1, Math.max(0, tagScore));

  // The content score is capped at 1, which this many matching memories reach.
  const enough = Math.max(5, N * CONTENT_ENOUGH_FRACTION);
  let contentMatches = 0;
  for (const text of source.contents) {
    const entryTokens = significantTokens(text);
    let shared = 0;
    for (const token of newTokens) {
      if (entryTokens.has(token)) shared++;
    }
    if (shared / newTokens.size > CONTENT_TOKEN_SHARE_MIN && ++contentMatches >= enough) break;
  }
  const contentScore = Math.min(1, contentMatches / enough);

  const fit = TAG_FIT_WEIGHT * tagScore + CONTENT_FIT_WEIGHT * contentScore;
  return Math.min(1, Math.max(0, fit));
}

function inferValence(tags: string[]): EmotionalValence {
  if (tags.includes('critical')) return 'critical';
  if (tags.includes('error')) return 'negative';
  if (tags.includes('success') || tags.includes('win')) return 'positive';
  return 'neutral';
}

/**
 * Update retrieval metadata on entries that were returned by a search.
 * Returns the mutated copies (caller must persist to disk).
 *
 * EVAL-ONLY ablation (see ablation.ts): with HIPPO_ABLATE_RECALL_BOOST set,
 * this returns the entries UNMUTATED - neutralizing all three strengthening
 * sub-effects (clock reset, retrieval_count, half-life increment) at the
 * single shared write site. The entries (not an empty array) must be
 * returned because callers derive `last_retrieval_ids` from the return
 * value, and a later `hippo outcome --good/--bad` targets those ids - an
 * empty return would silently co-ablate the outcome channel in the
 * strengthen-off arm. PERSISTENCE is gated separately at
 * each persisting caller (CLI recall, api context, MCP recall/context,
 * consolidation replay): writeEntry on identical rows still refreshes
 * updated_at, rewrites mirrors, and marks DAG parents dirty,
 * so those write loops skip under the flag.
 * The default `now` honors HIPPO_FAKE_NOW (simulated-time protocols).
 */
// Confidence is deliberately absent below: it is an epistemic tier, not a
// recency signal, and a stored 'stale' is always a deliberate mark.
export function markRetrieved(entries: MemoryEntry[], now: Date = evalNow()): MemoryEntry[] {
  if (isRecallBoostAblated()) return entries;
  return entries.map((e) => {
    if (e.superseded_by) return e;
    const wrong = netWrong(e) > 0;
    const updated: MemoryEntry = {
      ...e,
      retrieval_count: e.retrieval_count + 1,
      last_retrieved: wrong ? e.last_retrieved : now.toISOString(),
      // +2 days half-life per retrieval (PLAN.md); a wrong memory keeps both, since last_retrieved is the decay anchor
      half_life_days: wrong ? e.half_life_days : e.half_life_days + 2,
    };
    updated.strength = calculateStrength(updated, now);
    return updated;
  });
}
