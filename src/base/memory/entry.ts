// The memory entry: its shape, kinds and tags, how one is created, succeeded and retrieved, and its
// schema fit.
import { DEFAULT_TENANT_ID } from '../util/tenant.js';
import { BadRequestError } from '../errors/api-errors.js';
import { randomUUID } from 'node:crypto';
import { isJsonString } from '../util/json.js';
import { tokenize } from '../util/tokenize.js';
import { ID_SUFFIX_CHARS } from '../util/token-text.js';
import {
  calculateStrengthAt,
  netWrong,
  PRODUCTION_STRENGTH,
  type StrengthModel,
} from './strength.js';

export const DEFAULT_SCHEMA_FIT = 0.5;

export enum Layer {
  Buffer = 'buffer',
  Episodic = 'episodic',
  Semantic = 'semantic',
  Trace = 'trace', // ordered action→outcome sequence for RSI
}

export type EmotionalValence = 'neutral' | 'positive' | 'negative' | 'critical';

export type ConfidenceLevel = 'verified' | 'observed' | 'inferred' | 'stale';

export type TraceOutcome = 'success' | 'failure' | 'partial' | null;

export const MEMORY_KINDS = ['raw', 'distilled', 'superseded', 'archived'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

// Timestamps are Date.toISOString() output (ISO_STAMP_CHARS chars, UTC, ms, trailing Z), so byte
// comparison sorts them chronologically. The row writer stores `created` in that form (isoInstant);
// only rows written before it may hold another.

// Fields are camelCase in memory; src/base/memory/memory-wire.ts keeps the snake_case keys of every
// stored and wire format.
export interface MemoryEntry {
  id: string;
  created: string; // ISO 8601
  lastRetrieved: string; // ISO 8601
  retrievalCount: number;
  strength: number; // 0..1, current computed strength
  halfLifeDays: number;
  layer: Layer;
  tags: string[];
  emotionalValence: EmotionalValence;
  schemaFit: number; // 0..1
  source: string;
  outcomeScore: number | null; // null = no feedback yet
  outcomePositive: number; // cumulative positive outcome count
  outcomeNegative: number; // cumulative negative outcome count
  conflictsWith: string[];
  pinned: boolean;
  confidence: ConfidenceLevel; // epistemic confidence tier
  content: string; // the actual memory text
  parents: string[]; // IDs of source memories this was consolidated from (may be empty)
  starred: boolean; // user-bookmarked
  traceOutcome: TraceOutcome; // final outcome for trace-layer entries; null otherwise
  sourceSessionId: string | null; // set by auto-promote and session digests; null for everything else
  validFrom: string; // ISO 8601 timestamp when this belief became true
  supersededBy: string | null; // ID of the memory that replaced this one; null = current
  extractedFrom: string | null;
  dagLevel: number; // 0=leaf, 1=extracted_fact, 2=topic_summary, 3=entity_profile (independent of envelope `kind`)
  dagParentId: string | null; // ID of parent summary node in the DAG; null = root level
  // Cached DAG metadata for level-2+ summaries so recall can bound scope without re-walking; always
  // 0 / null on leaves and facts.
  descendantCount?: number;
  earliestAt?: string | null;
  latestAt?: string | null;
  /**
   * True when a child was invalidated, superseded, forgotten or archived since the last rebuild;
   * sleep clears it. Always false below level 2.
   */
  summaryDirty?: boolean;
  /** ISO 8601 time of the last successful rebuild, or null if never rebuilt. */
  lastRebuiltAt?: string | null;
  /** Count of successful rebuilds: 0 at the first buildDag write, bumped by each rebuild. */
  rebuildCount?: number;
  /** Reserved: ISO 8601 time the level-3 entity profile was built; only set on dag_level=3 rows. */
  dagLevel3BuiltAt?: string | null;
  // Provenance envelope
  kind: MemoryKind; // raw | distilled | superseded | archived
  scope: string | null; // e.g. 'team:eng', 'project:foo'; null = global
  owner: string | null; // 'user:<id>' or 'agent:<id>'
  artifactRef: string | null; // URI to source artifact (slack://, gh://, file://)
  tenantId: string; // 'default' for single-tenant deployments
  /**
   * Owning project, lowercased; '' = user-global (injectable everywhere), null = none known
   * (legacy or unnamed write), denied by ambient context. Stamped at write time by
   * stampOriginProject (sqlite/entries/entry-row.ts); undefined only before the first write. */
  originProject?: string | null;
}

/** Named dag_level values; level 0 is a raw leaf. */
export const DAG_LEVEL = { extracted: 1, topic: 2, entity: 3 } as const;

/** Tag on a memory whose named file/symbol/script changed after it was stored. */
export const CHURN_STALE_TAG = 'churn-stale';

/** Tag on a memory that records a failure or mistake. */
export const ERROR_TAG = 'error';

/** Tag on a fact the extractor pulled out of a longer source. */
export const EXTRACTED_TAG = 'extracted';

export const COMPACTION_MEMORY_TAG = 'compaction-memory';
export const COMPACTION_SOURCE_PREFIX = 'compaction:';

/** A memory counts as high schema fit strictly above this. */
export const HIGH_SCHEMA_FIT = 0.7;
const HIGH_FIT_HALF_LIFE_FACTOR = 1.5;
const LOW_SCHEMA_FIT = 0.3;
const LOW_FIT_HALF_LIFE_FACTOR = 0.5;
// Schema fit blends tag coverage and content similarity; a content match needs this share of
// shared tokens.
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

  if (entry.tags?.includes(ERROR_TAG)) {
    hl *= ERROR_TAG_HALF_LIFE_FACTOR;
  }

  if (entry.schemaFit !== undefined && entry.schemaFit > HIGH_SCHEMA_FIT) {
    hl *= HIGH_FIT_HALF_LIFE_FACTOR;
  }

  if (entry.schemaFit !== undefined && entry.schemaFit < LOW_SCHEMA_FIT) {
    hl *= LOW_FIT_HALF_LIFE_FACTOR;
  }

  return hl;
}

/** A new id: `prefix_` plus the first `chars` hex characters of a random UUID. */
export function generateId(prefix: string = 'mem', chars: number = ID_SUFFIX_CHARS): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, chars)}`;
}

export interface CreateMemoryOptions {
  layer?: Layer;
  tags?: string[];
  emotionalValence?: EmotionalValence;
  pinned?: boolean;
  schemaFit?: number;
  source?: string;
  confidence?: ConfidenceLevel;
  /**
   * The store config's `defaultHalfLifeDays`; required so no writer silently gets the
   * compiled default.
   */
  baseHalfLifeDays: number;
  traceOutcome?: TraceOutcome;
  sourceSessionId?: string | null;
  validFrom?: string;
  extractedFrom?: string;
  dagLevel?: number;
  dagParentId?: string;
  kind?: MemoryKind;
  scope?: string | null;
  owner?: string | null;
  artifactRef?: string | null;
  tenantId?: string;
}

/** A new memory entry created at `now`; hippo's own writers name the half-life base, so the type
 * asks for it. */
export function createMemoryAt(
  content: string,
  options: CreateMemoryOptions,
  now: Date,
): MemoryEntry {
  assertValidMemoryInput(content, options);

  const at = now.toISOString();
  const layer = options.layer ?? Layer.Episodic;
  const tags = options.tags ?? [];
  const schemaFit = options.schemaFit ?? DEFAULT_SCHEMA_FIT;

  const halfLifeDays = deriveHalfLife(options.baseHalfLifeDays, { tags, schemaFit });

  const entry: MemoryEntry = {
    id: generateId(layer === Layer.Semantic ? 'sem' : 'mem'),
    created: at,
    lastRetrieved: at,
    retrievalCount: 0,
    strength: 1.0,
    halfLifeDays,
    layer,
    tags,
    emotionalValence: options.emotionalValence ?? inferValence(tags),
    schemaFit,
    source: options.source ?? 'cli',
    outcomeScore: null,
    outcomePositive: 0,
    outcomeNegative: 0,
    conflictsWith: [],
    pinned: options.pinned ?? false,
    confidence: options.confidence ?? 'verified',
    content,
    ...newLineage(options, at),
  };

  entry.strength = calculateStrengthAt(entry, now, PRODUCTION_STRENGTH);
  return entry;
}

type EntryLineage = Pick<
  MemoryEntry,
  | 'parents'
  | 'starred'
  | 'traceOutcome'
  | 'sourceSessionId'
  | 'validFrom'
  | 'supersededBy'
  | 'extractedFrom'
  | 'dagLevel'
  | 'dagParentId'
  | 'kind'
  | 'scope'
  | 'owner'
  | 'artifactRef'
  | 'tenantId'
>;

function newLineage(options: CreateMemoryOptions, at: string): EntryLineage {
  return {
    parents: [],
    starred: false,
    traceOutcome: options.traceOutcome ?? null,
    sourceSessionId: options.sourceSessionId ?? null,
    validFrom: options.validFrom ?? at,
    supersededBy: null,
    extractedFrom: options.extractedFrom ?? null,
    dagLevel: options.dagLevel ?? 0,
    dagParentId: options.dagParentId ?? null,
    kind: options.kind ?? 'distilled',
    scope: options.scope ?? null,
    owner: options.owner ?? null,
    artifactRef: options.artifactRef ?? null,
    tenantId: options.tenantId ?? DEFAULT_TENANT_ID,
  };
}

function assertValidMemoryInput(content: string, options: Partial<CreateMemoryOptions>): void {
  const trimmed = content.trim();
  if (trimmed.length < 3) {
    throw new BadRequestError(
      `Memory content too short (${trimmed.length} chars, minimum 3): "${trimmed}"`,
    );
  }

  const validOutcomes: (string | null)[] = ['success', 'failure', 'partial', null];
  if (options.traceOutcome !== undefined && !validOutcomes.includes(options.traceOutcome)) {
    throw new BadRequestError(
      `Invalid trace_outcome: ${options.traceOutcome}. Must be 'success', 'failure', 'partial', or null.`,
    );
  }
}

/** What createSuccessor takes beyond the old row, the new text and the time. */
export interface SuccessorOptions {
  readonly tenantId: string;
  readonly baseHalfLifeDays: number;
  readonly layer?: Layer;
  readonly tags?: string[];
  readonly pinned?: boolean;
}

/** The row that replaces `old`, created at `now`: a supersede never changes where a memory
 * belongs or whose it is, so source, scope, owner, session and a stamped origin carry over. */
export function createSuccessor(
  old: MemoryEntry,
  content: string,
  opts: SuccessorOptions,
  now: Date,
): MemoryEntry {
  const fields: CreateMemoryOptions = {
    layer: opts.layer ?? old.layer,
    tags: opts.tags ?? [...old.tags],
    pinned: opts.pinned ?? old.pinned,
    source: old.source,
    confidence: 'verified',
    tenantId: opts.tenantId,
    scope: old.scope,
    owner: old.owner,
    sourceSessionId: old.sourceSessionId,
    baseHalfLifeDays: opts.baseHalfLifeDays,
  };
  const next = createMemoryAt(content, fields, now);
  // A legacy null origin has nothing to carry, so the store stamps it from its own location.
  if (isJsonString(old.originProject)) {
    next.originProject = old.originProject;
  }
  return next;
}

/**
 * How well new content fits existing knowledge, 0..1: above HIGH_SCHEMA_FIT consolidates
 * faster, below LOW_SCHEMA_FIT is novel and decays faster if unused. Tags shared with existing
 * memories count by rarity (a rare shared tag fits more), plus content-token overlap. */
export function computeSchemaFit(
  content: string,
  tags: string[],
  existingEntries: MemoryEntry[],
): number {
  return schemaFitFrom(content, tags, schemaFitSourceOf(existingEntries));
}

/** What schema fit reads from `entries`, built once for a caller that scores many contents
 * against the same rows. */
export function schemaFitSourceOf(entries: readonly MemoryEntry[]): SchemaFitSource {
  const tagCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return { rows: entries.length, tagCounts, contents: entries.map((e) => e.content) };
}

/** What schema fit reads from a set of memories, so a store can answer without loading its rows. */
export interface SchemaFitSource {
  readonly rows: number;
  /** How many times each tag appears across the set. */
  readonly tagCounts: ReadonlyMap<string, number>;
  /** Each memory's text; the walk stops once more matches cannot move the score. */
  readonly contents: Iterable<string>;
}

// Tokens of this length or shorter are filler for schema fit.
const FILLER_TOKEN_MAX_LENGTH = 3;
// Matching half the tags at average weight scores about 0.5, so the raw overlap ratio is doubled.
const TAG_OVERLAP_SCALE = 2;
// Floor on the matches that saturate the content score, so a tiny store cannot saturate it on
// one hit.
const CONTENT_ENOUGH_MIN_MATCHES = 5;

function significantTokens(text: string): Set<string> {
  return new Set(tokenize(text).filter((t) => t.length > FILLER_TOKEN_MAX_LENGTH));
}

/** computeSchemaFit against `source`, for a caller that holds counts and texts but no rows. */
export function schemaFitFrom(
  content: string,
  tags: readonly string[],
  source: SchemaFitSource,
): number {
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
  const tagScore =
    totalWeight > 0 ? Math.min(1, (weightedOverlap / totalWeight) * TAG_OVERLAP_SCALE) : 0;

  const newTokens = significantTokens(content);
  if (newTokens.size === 0) return Math.min(1, Math.max(0, tagScore));

  // The content score is capped at 1, which this many matching memories reach.
  const enough = Math.max(CONTENT_ENOUGH_MIN_MATCHES, N * CONTENT_ENOUGH_FRACTION);
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
  if (tags.includes(ERROR_TAG)) return 'negative';
  if (tags.includes('success') || tags.includes('win')) return 'positive';
  return 'neutral';
}

/** Copies with the retrieval count, clock and half-life updated at `now`; the caller persists
 * them. A model whose recall does not strengthen returns the entries unchanged, not empty, since
 * callers derive last_retrieval_ids. */
export function markRetrievedAt(
  entries: MemoryEntry[],
  now: Date,
  model: StrengthModel,
): MemoryEntry[] {
  if (!model.recallStrengthens) return entries;
  return entries.map((e) => {
    if (e.supersededBy) return e;
    const wrong = netWrong(e, model) > 0;
    // Confidence stays untouched: it is an epistemic tier, not a recency signal.
    const updated: MemoryEntry = {
      ...e,
      retrievalCount: e.retrievalCount + 1,
      // A wrong memory keeps both, since last_retrieved is the decay anchor.
      lastRetrieved: wrong ? e.lastRetrieved : now.toISOString(),
      halfLifeDays: wrong ? e.halfLifeDays : e.halfLifeDays + RETRIEVAL_HALF_LIFE_GAIN_DAYS,
    };
    updated.strength = calculateStrengthAt(updated, now, model);
    return updated;
  });
}
