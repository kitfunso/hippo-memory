/**
 * Core data model for Hippo memory entries.
 * Based on the strength formula from PLAN.md.
 */

export enum Layer {
  Buffer = 'buffer',
  Episodic = 'episodic',
  Semantic = 'semantic',
}

export type EmotionalValence = 'neutral' | 'positive' | 'negative' | 'critical';

export type ConfidenceLevel = 'verified' | 'observed' | 'inferred' | 'stale';

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
  conflicts_with: string[];
  pinned: boolean;
  confidence: ConfidenceLevel;  // epistemic confidence tier
  content: string;         // the actual memory text
}

// Emotional multipliers from PLAN.md
const EMOTIONAL_MULTIPLIERS: Record<EmotionalValence, number> = {
  neutral: 1.0,
  positive: 1.3,
  negative: 1.5,  // error-tagged
  critical: 2.0,
};

/**
 * Calculate current strength at a given time.
 * strength(t) = base_strength * decay * retrieval_boost * emotional_multiplier
 *
 * Pinned memories always return 1.0 (no decay).
 *
 * Side effect: if daysSince > 30 and confidence is not 'verified', the
 * returned object should be treated as 'stale'. Use resolveConfidence() for that.
 */
export function calculateStrength(entry: MemoryEntry, now: Date = new Date()): number {
  if (entry.pinned) return 1.0;

  const lastRetrieved = new Date(entry.last_retrieved);
  const daysSince = (now.getTime() - lastRetrieved.getTime()) / (1000 * 60 * 60 * 24);

  // Exponential decay: base * (0.5 ^ (days / half_life))
  const decay = Math.pow(0.5, daysSince / entry.half_life_days);

  // Retrieval boost: 1 + 0.1 * log2(retrieval_count + 1)
  const retrievalBoost = 1 + 0.1 * Math.log2(entry.retrieval_count + 1);

  // Emotional multiplier
  const emotionalMultiplier = EMOTIONAL_MULTIPLIERS[entry.emotional_valence] ?? 1.0;

  const raw = decay * retrievalBoost * emotionalMultiplier;

  // Clamp to [0, 1]
  return Math.min(1.0, Math.max(0.0, raw));
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
 * Positive: +5 days half-life. Negative: -3 days.
 */
export function applyOutcome(entry: MemoryEntry, good: boolean): MemoryEntry {
  const delta = good ? 5 : -3;
  const newHalfLife = Math.max(1, entry.half_life_days + delta);
  const newOutcome = good ? 1 : -1;
  const updated = { ...entry, half_life_days: newHalfLife, outcome_score: newOutcome };
  updated.strength = calculateStrength(updated);
  return updated;
}

/**
 * Generate a random memory ID.
 */
export function generateId(prefix: string = 'mem'): string {
  const hex = Math.random().toString(16).slice(2, 8) + Math.random().toString(16).slice(2, 8);
  return `${prefix}_${hex.slice(0, 8)}`;
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
  } = {}
): MemoryEntry {
  const now = new Date().toISOString();
  const layer = options.layer ?? Layer.Episodic;
  const tags = options.tags ?? [];
  const emotional_valence = options.emotional_valence ?? inferValence(tags);
  const schema_fit = options.schema_fit ?? 0.5;

  const partial: Partial<MemoryEntry> = { tags, schema_fit };
  const half_life_days = deriveHalfLife(7, partial);

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
    conflicts_with: [],
    pinned: options.pinned ?? false,
    confidence: options.confidence ?? 'verified',
    content,
  };

  // Recalculate strength with the emotional multiplier applied
  entry.strength = calculateStrength(entry);
  return entry;
}

function inferValence(tags: string[]): EmotionalValence {
  if (tags.includes('critical')) return 'critical';
  if (tags.includes('error')) return 'negative';
  if (tags.includes('success') || tags.includes('win')) return 'positive';
  return 'neutral';
}
