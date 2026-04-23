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
  dag_level: number;            // 0=raw, 1=extracted_fact, 2=topic_summary, 3=entity_profile
  dag_parent_id: string | null; // ID of parent summary node in the DAG; null = root level
}

export const DECISION_HALF_LIFE_DAYS = 90;

// Emotional multipliers from PLAN.md
const EMOTIONAL_MULTIPLIERS: Record<EmotionalValence, number> = {
  neutral: 1.0,
  positive: 1.3,
  negative: 1.5,  // error-tagged
  critical: 2.0,
};

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
  const emotionalMultiplier = EMOTIONAL_MULTIPLIERS[entry.emotional_valence] ?? 1.0;

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
