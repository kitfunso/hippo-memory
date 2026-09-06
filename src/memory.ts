// Memory entry data model. Strength formula: PLAN.md.

import { randomUUID } from 'crypto';
import {
  isDecayAblated,
  isOutcomeSlowAblated,
  isRecallBoostAblated,
  evalNow,
} from './ablation.js';

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

/** Timestamps are canonical UTC `toISOString()`; legacy markdown-rebuilt rows may carry non-canonical offsets uncorrected, and the byte-comparison sort used for chronological ordering assumes the canonical form (see ARCHITECTURE.md). */

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
  /** Cached DAG metadata: populated for level-2+ summary rows so recall can reason about scope without re-walking the DAG; 0/null for level-0/1 rows. */
  descendant_count?: number;
  earliest_at?: string | null;
  latest_at?: string | null;
  /** 1 when a child has been invalidated/superseded/forgotten/archived since the last rebuild; cleared by the sleep-time dirty-summary rebuild. 0 for non-summary rows. */
  summary_dirty?: 0 | 1;
  /** ISO timestamp of the last successful rebuild, or null if never rebuilt. */
  last_rebuilt_at?: string | null;
  /** Monotonically-increasing count of successful rebuilds; 0 until the first rebuild. */
  rebuild_count?: number;
  /** ISO timestamp the level-3 entity profile was built; only set on dag_level=3 rows. */
  dag_level_3_built_at?: string | null;
  // A3 provenance envelope (schema v14)
  kind: MemoryKind;             // raw | distilled | superseded | archived
  scope: string | null;         // e.g. 'team:eng', 'project:foo'; null = global
  owner: string | null;         // 'user:<id>' or 'agent:<id>'
  artifact_ref: string | null;  // URI to source artifact (slack://, gh://, file://)
  // A5 stub auth (schema v16)
  tenantId: string;             // 'default' for single-tenant deployments
  /** Owning project for ambient-context partitioning: lowercased name, '' = always-injectable user-global, null = legacy pre-v39 (denied as other-project). Stamped from the store location at write time. */
  origin_project?: string | null;
  /** Raw SQLite FTS5 bm25() score, populated only on the FTS-matched path of loadSearchEntries (undefined otherwise). Negative/ascending scale, NOT comparable to search.ts's JS BM25 — provenance/rank metadata only (see ARCHITECTURE.md). */
  bm25_score?: number;
}

export const DECISION_HALF_LIFE_DAYS = 90;

export const INCIDENT_HALF_LIFE_DAYS = 90;

export const PROCESS_HALF_LIFE_DAYS = 90;

export const POLICY_HALF_LIFE_DAYS = 90;

export const SKILL_HALF_LIFE_DAYS = 90;

export const PROJECT_BRIEF_HALF_LIFE_DAYS = 90;

export const CUSTOMER_NOTE_HALF_LIFE_DAYS = 90;

// Negative valence weighted 2x per loss-aversion calibration (losses ~2x gains, Lovallo-Kahneman); tunable via HIPPO_LOSS_AVERSION_RATIO (see ARCHITECTURE.md).
const EMOTIONAL_MULTIPLIERS: Record<EmotionalValence, number> = {
  neutral: 1.0,
  positive: 1.0,
  negative: 2.0,  // error-tagged
  critical: 2.0,
};

/** Lazy-cached read of HIPPO_LOSS_AVERSION_RATIO — avoids a per-entry process.env lookup in hot recall loops; reset via _resetLossAversionRatioCacheForTests(). */

/** Floor below which the negative multiplier could let strength * decay fall under consolidate.ts's DECAY_THRESHOLD (0.05), permanently deleting error-tagged memories on the next sleep cycle (see ARCHITECTURE.md). */
const LOSS_AVERSION_RATIO_MIN = 0.5;

/** Valid: finite numbers >= 0.5. Anything else (empty, non-numeric, <0.5, NaN, +/-Infinity) silently falls back to 1.0 — an opt-in env var should not crash recall on a typo. */
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

/** Test-only. Tests mutating HIPPO_LOSS_AVERSION_RATIO MUST call this in BOTH beforeEach and afterEach, or cache state leaks between tests (see tests/emotional-multipliers-j5.test.ts). */
export function _resetLossAversionRatioCacheForTests(): void {
  _lossAversionRatioCache = undefined;
}

/** Scales only the negative multiplier; critical/positive/neutral pass through unchanged — the calibration targets only the losses-vs-gains claim. */
function applyLossAversionRatio(
  valence: EmotionalValence,
  baseMultiplier: number,
): number {
  if (valence !== 'negative') return baseMultiplier;
  return baseMultiplier * getLossAversionRatio();
}

/** reward_factor = 1 + 0.5 * (pos-neg)/(pos+neg+1), range (0.5,1.5); modulates half-life so consistently positive-outcome memories decay slower. */
export function calculateRewardFactor(entry: MemoryEntry): number {
  // EVAL-ONLY ablation (see ablation.ts): the slow outcome channel.
  if (isOutcomeSlowAblated()) return 1.0;
  const pos = entry.outcome_positive ?? 0;
  const neg = entry.outcome_negative ?? 0;
  if (pos === 0 && neg === 0) return 1.0;
  const ratio = (pos - neg) / (pos + neg + 1);
  return 1 + 0.5 * ratio;
}

/** Decay basis: clock = wall-time (default); session = decay by sleep-cycle count; adaptive = wall-time with half-life scaled by session frequency. */
export interface DecayOptions {
  decayBasis?: 'clock' | 'session' | 'adaptive';
  /** Average interval between sleep cycles, in days. Used by 'adaptive' and 'session' modes. */
  avgSessionIntervalDays?: number;
  /** Total sleep cycles completed. Used by consolidation tracking. */
  sleepCount?: number;
}

/** strength(t) = base * decay * retrievalBoost * emotionalMultiplier (decay basis set via DecayOptions.decayBasis); pinned memories always return 1.0. */
export function calculateStrength(
  entry: MemoryEntry,
  // evalNow(): the real clock unless HIPPO_FAKE_NOW is set (eval-only,
  // simulated-time protocols; see ablation.ts). Explicit `now` always wins.
  now: Date = evalNow(),
  options: DecayOptions = {},
): number {
  if (entry.pinned) return 1.0;

  // EVAL-ONLY ablation: with recall-boost ablated, anchor decay at CREATION not last_retrieved, so prior-run strengthening can't leak into this arm's rankings (see ARCHITECTURE.md).
  const lastRetrieved = new Date(
    isRecallBoostAblated() ? entry.created : entry.last_retrieved,
  );
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

  // EVAL-ONLY ablation: decay forced to 1; the [0,1] clamp below then caps retrievalBoost at baseline (see ablation.ts).
  const decay = isDecayAblated() ? 1.0 : Math.pow(0.5, decayExponent);

  // EVAL-ONLY ablation: recall-boost also neutralizes reads, so pre-flag retrieval history can't leak strengthening into this arm.
  const retrievalBoost = isRecallBoostAblated()
    ? 1.0
    : 1 + 0.1 * Math.log2(entry.retrieval_count + 1);

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

/** Records outcome feedback and recomputes strength via the updated reward factor (see calculateRewardFactor) — no fixed half-life delta, decay adjusts proportionally to cumulative reward. */
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

/** Entries unretrieved for 30+ days report 'stale' unless already 'verified'. */
export function resolveConfidence(entry: MemoryEntry, now: Date = evalNow()): ConfidenceLevel {
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

  const now = evalNow().toISOString(); // honors HIPPO_FAKE_NOW (eval-only)
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

/** Schema fit 0..1: >0.7 = high (consolidates faster), 0.3-0.7 = moderate, <0.3 = novel (decays faster). IDF-weighted tag overlap blended with content-token overlap. */
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
