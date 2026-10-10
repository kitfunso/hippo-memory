/** Core data model for Hippo memory entries, based on the strength formula from PLAN.md. */

import { DEFAULT_TENANT_ID, envLossAversionRatio } from '../util/env.js';
import { BadRequestError } from './api-errors.js';
import { randomUUID } from 'crypto';
import {
  isDecayAblated,
  isOutcomeSlowAblated,
  isRecallBoostAblated,
  evalNow,
} from './ablation.js';
import { AGENT_MEMORY_TOOLS, toolSourcePrefix } from './agent-memory-tools.js';
import { isJsonString } from '../util/json.js';
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

// Timestamps are Date.toISOString() output (24 chars, UTC, ms, trailing Z), so byte comparison sorts them chronologically.
// A markdown rebuild keeps legacy offsets as written, so importers should normalize on write.

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
  // Cached DAG metadata for level-2+ summaries so recall can bound scope without re-walking; always 0 / null on leaves and facts.
  descendant_count?: number;
  earliest_at?: string | null;
  latest_at?: string | null;
  /** 1 when a child was invalidated, superseded, forgotten or archived since the last rebuild; sleep clears it. Always 0 below level 2. */
  summary_dirty?: 0 | 1;
  /** ISO 8601 time of the last successful rebuild, or null if never rebuilt. */
  last_rebuilt_at?: string | null;
  /** Count of successful rebuilds: 0 at the first buildDag write, bumped by each rebuild. */
  rebuild_count?: number;
  /** Reserved: ISO 8601 time the level-3 entity profile was built; only set on dag_level=3 rows. */
  dag_level_3_built_at?: string | null;
  // Provenance envelope
  kind: MemoryKind;             // raw | distilled | superseded | archived
  scope: string | null;         // e.g. 'team:eng', 'project:foo'; null = global
  owner: string | null;         // 'user:<id>' or 'agent:<id>'
  artifact_ref: string | null;  // URI to source artifact (slack://, gh://, file://)
  tenantId: string;             // 'default' for single-tenant deployments
  /** Owning project, lowercased; '' = user-global (injectable everywhere), null = none known (legacy or unnamed write), denied by ambient context.
   *  Stamped at write time by stampOriginProject (src/store/entry-row.ts); undefined only before the first write. */
  origin_project?: string | null;
  /** Raw FTS5 bm25() from the search path (negative, lower = better); set only for a non-empty query the FTS join answered.
   *  Not comparable to the JS scorer in src/search/bm25.ts, so read it as rank metadata only. */
  bm25_score?: number;
}

/** Tag on a memory whose named file/symbol/script changed after it was stored. */
export const CHURN_STALE_TAG = 'churn-stale';

// Losses weigh ~2x gains (Lovallo-Kahneman), so negative is 2.0; HIPPO_LOSS_AVERSION_RATIO scales it per process.
export const EMOTIONAL_MULTIPLIERS = {
  neutral: 1.0,
  positive: 1.0,
  negative: 2.0,  // error-tagged
  critical: 2.0,
} satisfies Record<EmotionalValence, number>;

// A lower ratio can drop an error-tagged memory under sleep's DECAY_THRESHOLD (src/consolidate/decay.ts),
// so values below it fall back to 1.0.
const LOSS_AVERSION_RATIO_MIN = 0.5;

// Read once: calculateStrength runs per entry inside hot loops (src/api, src/consolidate, src/search).
let _lossAversionRatioCache: number | undefined;

function getLossAversionRatio(): number {
  if (_lossAversionRatioCache !== undefined) return _lossAversionRatioCache;
  const raw = envLossAversionRatio();
  if (raw === undefined || raw === '') {
    _lossAversionRatioCache = 1.0;
    return 1.0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < LOSS_AVERSION_RATIO_MIN) {
    _lossAversionRatioCache = 1.0;
    return 1.0;
  }
  _lossAversionRatioCache = parsed;
  return parsed;
}

/** Test-only: a test that sets HIPPO_LOSS_AVERSION_RATIO calls this in beforeEach and afterEach (tests/emotional-multipliers.test.ts). */
export function _resetLossAversionRatioCacheForTests(): void {
  _lossAversionRatioCache = undefined;
}

/** Scales only the `negative` multiplier; `critical` stays unscaled so the knob moves just the losses-vs-gains claim. */
export function applyLossAversionRatio(
  valence: EmotionalValence,
  baseMultiplier: number,
): number {
  if (valence !== 'negative') return baseMultiplier;
  return baseMultiplier * getLossAversionRatio();
}

/** 1 + REWARD_SLOPE * (pos - neg) / (pos + neg + 1), in (0.5, 1.5), 1.0 with no outcomes; it scales the effective half-life. */
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

/** Bad outcome marks past good ones, floored at zero; each halves strength and stops recall strengthening, so a correction outranks pinning. */
export function netWrong(entry: Pick<MemoryEntry, 'outcome_positive' | 'outcome_negative'>): number {
  if (isOutcomeSlowAblated() || isDecayAblated()) return 0;
  return Math.max(0, (entry.outcome_negative ?? 0) - (entry.outcome_positive ?? 0));
}

/** What calculateStrength reads, so a caller can score a row without loading its text. */
export type StrengthInputs = Pick<
  MemoryEntry,
  'pinned' | 'created' | 'last_retrieved' | 'half_life_days' | 'retrieval_count' | 'emotional_valence' | 'outcome_positive' | 'outcome_negative'
>;

/** Decay basis: clock = wall time, session = per sleep cycle (intermittent agents), adaptive = half-life scaled by session frequency. */
export interface DecayOptions {
  decayBasis?: 'clock' | 'session' | 'adaptive';
  /** Average interval between sleep cycles, in days. Used by 'adaptive' and 'session' modes. */
  avgSessionIntervalDays?: number;
  /** Total sleep cycles completed. Used by consolidation tracking. */
  sleepCount?: number;
}

/** Strength at `now` = decay * retrieval boost * emotional multiplier, clamped to [0, 1]; the basis modes are on DecayOptions.
 *  Pinned memories skip time decay, but being marked wrong still fades them (netWrong). */
export function calculateStrength(
  entry: StrengthInputs,
  // evalNow() is the real clock unless HIPPO_FAKE_NOW is set (eval-only); an explicit `now` wins.
  now: Date = evalNow(),
  options: DecayOptions = {},
): number {
  // Being marked wrong outranks every shield: pinning, error tags, heavy recall.
  const wrongPenalty = Math.pow(DECAY_BASE, Math.min(netWrong(entry), MAX_WRONG_HALVINGS));
  if (entry.pinned) return wrongPenalty;

  // EVAL-ONLY ablation (see ablation.ts): anchor decay at creation so clock resets from earlier unflagged runs cannot leak in.
  const lastRetrieved = new Date(
    isRecallBoostAblated() ? entry.created : entry.last_retrieved,
  );
  const daysSince = (now.getTime() - lastRetrieved.getTime()) / DAY_MS;

  const rewardFactor = calculateRewardFactor(entry);
  const effectiveHalfLife = entry.half_life_days * rewardFactor;

  // Guard: zero half-life causes 0/0 = NaN in the exponent
  if (effectiveHalfLife <= 0) return 0.0;

  const decayExponent = decayExponentFor(options, daysSince, effectiveHalfLife);

  // EVAL-ONLY ablation (see ablation.ts): decay := 1, so the [0,1] clamp below caps the boost at baseline.
  const decay = isDecayAblated() ? 1.0 : Math.pow(DECAY_BASE, decayExponent);

  const retrievalBoost = retrievalBoostFor(entry);

  const baseMultiplier = EMOTIONAL_MULTIPLIERS[entry.emotional_valence] ?? 1.0;
  const emotionalMultiplier = applyLossAversionRatio(entry.emotional_valence, baseMultiplier);

  const raw = decay * retrievalBoost * emotionalMultiplier;

  const clamped = Math.min(1.0, Math.max(0.0, raw));
  return Number.isFinite(clamped) ? clamped * wrongPenalty : 0.0;
}

function decayExponentFor(options: DecayOptions, daysSince: number, halfLifeDays: number): number {
  let effectiveHalfLife = halfLifeDays;
  const basis = options.decayBasis ?? 'clock';
  if (basis === 'session') {
    // Each sleep cycle counts as one "day"; sessions since last retrieval are estimated from wall time and the average interval.
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
  return daysSince / effectiveHalfLife;
}

// EVAL-ONLY ablation (see ablation.ts) neutralizes the read side too, so counts written before the flag cannot leak in.
function retrievalBoostFor(entry: StrengthInputs): number {
  return isRecallBoostAblated() || netWrong(entry) > 0
    ? 1.0
    : 1 + RETRIEVAL_BOOST_SLOPE * Math.log2(entry.retrieval_count + 1);
}

const HIGH_SCHEMA_FIT = 0.7;
const HIGH_FIT_HALF_LIFE_FACTOR = 1.5;
const LOW_SCHEMA_FIT = 0.3;
const LOW_FIT_HALF_LIFE_FACTOR = 0.5;
// Schema fit blends tag coverage and content similarity; a content match needs this share of shared tokens.
const TAG_FIT_WEIGHT = 0.6;
const CONTENT_FIT_WEIGHT = 0.4;
const CONTENT_TOKEN_SHARE_MIN = 0.2;
const CONTENT_ENOUGH_FRACTION = 0.1;
// An error is worth remembering longer than a neutral note (PLAN.md half-life table).
const ERROR_TAG_HALF_LIFE_FACTOR = 2;
// Each retrieval lengthens the half-life by this many days (PLAN.md).
const RETRIEVAL_HALF_LIFE_GAIN_DAYS = 2;

/** The base half-life scaled by the PLAN.md signals: an error tag, and high or low schema fit. */
export function deriveHalfLife(base: number, entry: Partial<MemoryEntry>): number {
  let hl = base;

  if (entry.tags?.includes('error')) {
    hl *= ERROR_TAG_HALF_LIFE_FACTOR;
  }

  if (entry.schema_fit !== undefined && entry.schema_fit > HIGH_SCHEMA_FIT) {
    hl *= HIGH_FIT_HALF_LIFE_FACTOR;
  }

  if (entry.schema_fit !== undefined && entry.schema_fit < LOW_SCHEMA_FIT) {
    hl *= LOW_FIT_HALF_LIFE_FACTOR;
  }

  return hl;
}

/** Counts the outcome; calculateStrength turns the counts into a reward factor on the half-life, so there is no fixed delta here. */
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

/** A new id: `prefix_` plus the first ID_SUFFIX_CHARS hex characters of a random UUID. */
export function generateId(prefix: string = 'mem'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, ID_SUFFIX_CHARS)}`;
}

/** What the confidence facets read, so a caller can derive them from a row it loaded only in part. */
export type ConfidenceInputs = Pick<MemoryEntry, 'pinned' | 'confidence' | 'last_retrieved'>;

// Days without a retrieval before trust lapses; pinned and verified rows are exempt by policy.
const AGED_OUT_AFTER_DAYS = 30;

function isAgedOut(entry: ConfidenceInputs, now: Date): boolean {
  if (entry.pinned || entry.confidence === 'verified') return false;
  const lastRetrieved = new Date(entry.last_retrieved);
  return (now.getTime() - lastRetrieved.getTime()) / DAY_MS > AGED_OUT_AFTER_DAYS;
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

// An aged-out row warns on its own, since its stored tier alone would hide it.
export function confidenceLabel(entry: MemoryEntry, now: Date = evalNow()) {
  const { tier, agedOut } = confidenceFacets(entry, now);
  return {
    text: agedOut ? `${tier}, aged` : tier,
    warn: agedOut || tier === 'stale' || tier === 'inferred',
  };
}

/** The stored confidence, or 'stale' once the entry is aged out (not retrieved for AGED_OUT_AFTER_DAYS; pinned and verified exempt). */
export function resolveConfidence(entry: MemoryEntry, now: Date = evalNow()): ConfidenceLevel {
  return isAgedOut(entry, now) ? 'stale' : entry.confidence;
}

/** Base half-life in days before deriveHalfLife's multipliers: 365 because 7 lost the current fact far more often and 730 did no better.
 *  `hippo sleep` moves memories still on an older base (src/consolidate/half-life-migration.ts). */
export const DEFAULT_HALF_LIFE_DAYS = 365;

export const COMPACTION_MEMORY_TAG = 'compaction-memory';
export const COMPACTION_SOURCE_PREFIX = 'compaction:';

/** An imported agent memory is kept for good: the agent's note file is its record. It needs both its tool's tag and a source with that tool's prefix,
 *  since merge copies source tags onto rows whose source is 'consolidation'. */
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
  /** The store's `loadConfig(hippoRoot).defaultHalfLifeDays`; required so no writer silently gets the compiled default. */
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
    tenantId: options.tenantId ?? DEFAULT_TENANT_ID,
  };

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
  if (isJsonString(old.origin_project)) {
    next.origin_project = old.origin_project;
  }
  return next;
}

/** How well new content fits existing knowledge, 0..1: above 0.7 consolidates faster, below 0.3 is novel and decays faster if unused.
 *  Tags shared with existing memories count by rarity (a rare shared tag fits more), plus content-token overlap. */
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
  if (N === 0) return DEFAULT_SCHEMA_FIT;
  const tagFreq = source.tagCounts;
  if (tags.length === 0 && tagFreq.size === 0) return DEFAULT_SCHEMA_FIT;

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

/** Returns copies with the retrieval count, clock and half-life updated; the caller persists them.
 *  Under HIPPO_ABLATE_RECALL_BOOST (eval-only) the entries come back unchanged, not empty, since callers derive last_retrieval_ids from them. */
export function markRetrieved(entries: MemoryEntry[], now: Date = evalNow()): MemoryEntry[] {
  if (isRecallBoostAblated()) return entries;
  return entries.map((e) => {
    if (e.superseded_by) return e;
    const wrong = netWrong(e) > 0;
    // Confidence stays untouched: it is an epistemic tier, not a recency signal.
    const updated: MemoryEntry = {
      ...e,
      retrieval_count: e.retrieval_count + 1,
      // A wrong memory keeps both, since last_retrieved is the decay anchor.
      last_retrieved: wrong ? e.last_retrieved : now.toISOString(),
      half_life_days: wrong ? e.half_life_days : e.half_life_days + RETRIEVAL_HALF_LIFE_GAIN_DAYS,
    };
    updated.strength = calculateStrength(updated, now);
    return updated;
  });
}
