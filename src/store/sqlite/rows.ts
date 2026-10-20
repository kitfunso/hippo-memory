import { DEFAULT_TENANT_ID } from '../../base/util/tenant.js';
import {
  Layer,
  FALLBACK_HALF_LIFE_DAYS,
  DEFAULT_SCHEMA_FIT,
  type MemoryEntry,
  type ConfidenceLevel,
  type MemoryKind,
} from '../../base/memory/memory.js';
import { log } from '../../base/util/log.js';
import { type JsonValue, tryParseJson } from '../../base/util/json.js';
import { parseStoredObject, warnDamagedColumn, type StoredJsonSite } from '../../base/util/stored-json.js';
import type { SessionEvent, TaskSnapshot } from '../port/sessions.js';
import type { MemoryConflict } from '../port/conflicts.js';

export interface IndexEntry {
  id: string;
  file: string;
  layer: Layer;
  strength: number;
  tags: string[];
  created: string;
  last_retrieved: string;
  pinned: boolean;
}

export interface HippoIndex {
  version: number;
  entries: Record<string, IndexEntry>;
  last_retrieval_ids: string[];
  /** Id of the most recent recall_traces row written by contextGet/cmdRecall, mirrored from the `last_trace_id` meta
   *  key like last_retrieval_ids. null when none was written (api.recall never sets it). */
  last_trace_id: string | null;
}

// SAFETY: every read cast to this row selects MEMORY_SELECT_COLUMNS or MEMORY_SEARCH_COLUMNS.
// scripts/check-row-casts.mjs proves it.
export interface MemoryRow {
  id: string;
  created: string;
  last_retrieved: string;
  retrieval_count: number;
  strength: number;
  half_life_days: number;
  layer: string;
  tags_json: string;
  emotional_valence: MemoryEntry['emotionalValence'];
  schema_fit: number;
  source: string;
  outcome_score: number | null;
  outcome_positive: number;
  outcome_negative: number;
  conflicts_with_json: string;
  pinned: number;
  confidence: ConfidenceLevel;
  content: string;
  parents_json: string;
  starred: number;
  trace_outcome: MemoryEntry['traceOutcome'];
  source_session_id: string | null;
  valid_from: string | null;
  superseded_by: string | null;
  extracted_from: string | null;
  dag_level: number;
  dag_parent_id: string | null;
  kind: string | null;
  scope: string | null;
  owner: string | null;
  artifact_ref: string | null;
  tenant_id: string | null;
  // Memory scope isolation (schema v39).
  origin_project: string | null;
  descendant_count: number | null;
  earliest_at: string | null;
  latest_at: string | null;
  // In MEMORY_SELECT_COLUMNS so every read path populates these alongside descendant_count / earliest_at / latest_at.
  summary_dirty: number | null;
  last_rebuilt_at: string | null;
  rebuild_count: number | null;
  dag_level_3_built_at: string | null;
  // Present only on rows from MEMORY_SEARCH_COLUMNS (FTS path).
  // Other paths SELECT MEMORY_SELECT_COLUMNS, which does not include this.
  bm25_score?: number;
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
export interface ConsolidationRunRow {
  timestamp: string;
  decayed: number;
  merged: number;
  removed: number;
}

// SAFETY: every read cast to this row selects TASK_SNAPSHOT_COLUMNS; scripts/check-row-casts.mjs proves it.
export interface TaskSnapshotRow {
  id: number;
  task: string;
  summary: string;
  next_step: string;
  status: string;
  source: string;
  session_id: string | null;
  scope: string | null;
  created_at: string;
  updated_at: string;
}
export const TASK_SNAPSHOT_COLUMNS =
  'id, task, summary, next_step, status, source, session_id, scope, created_at, updated_at';

// SAFETY: every read cast to this row selects MEMORY_CONFLICT_COLUMNS; scripts/check-row-casts.mjs proves it.
export interface MemoryConflictRow {
  id: number;
  memory_a_id: string;
  memory_b_id: string;
  reason: string;
  score: number;
  status: string;
  detected_at: string;
  updated_at: string;
}
export const MEMORY_CONFLICT_COLUMNS = 'id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at';

// SAFETY: every read cast to this row selects SESSION_EVENT_COLUMNS; scripts/check-row-casts.mjs proves it.
export interface SessionEventRow {
  id: number;
  session_id: string;
  task: string | null;
  event_type: string;
  content: string;
  source: string;
  scope: string | null;
  metadata_json: string;
  created_at: string;
}
export const SESSION_EVENT_COLUMNS =
  'id, session_id, task, event_type, content, source, scope, metadata_json, created_at';

export const INDEX_VERSION = 3;
const MEMORY_COLUMN_NAMES = [
  'id',
  'created',
  'last_retrieved',
  'retrieval_count',
  'strength',
  'half_life_days',
  'layer',
  'tags_json',
  'emotional_valence',
  'schema_fit',
  'source',
  'outcome_score',
  'outcome_positive',
  'outcome_negative',
  'conflicts_with_json',
  'pinned',
  'confidence',
  'content',
  'parents_json',
  'starred',
  'trace_outcome',
  'source_session_id',
  'valid_from',
  'superseded_by',
  'extracted_from',
  'dag_level',
  'dag_parent_id',
  'kind',
  'scope',
  'owner',
  'artifact_ref',
  'tenant_id',
  'origin_project',
  'descendant_count',
  'earliest_at',
  'latest_at',
  'summary_dirty',
  'last_rebuilt_at',
  'rebuild_count',
  'dag_level_3_built_at',
] as const;

// FTS-join columns for loadSearchRows: `m.<col> AS <col>` keeps rowToEntry's unqualified reads working.
export const MEMORY_SELECT_COLUMNS = MEMORY_COLUMN_NAMES.join(', ');
export const MEMORY_SEARCH_COLUMNS = [
  ...MEMORY_COLUMN_NAMES.map((c) => `m.${c} AS ${c}`),
  'bm25(memories_fts) AS bm25_score',
].join(', ');
type RetrievalFields = Pick<
  MemoryEntry,
  | 'id'
  | 'created'
  | 'lastRetrieved'
  | 'retrievalCount'
  | 'strength'
  | 'halfLifeDays'
  | 'layer'
  | 'tags'
  | 'emotionalValence'
  | 'schemaFit'
  | 'source'
  | 'outcomeScore'
  | 'outcomePositive'
  | 'outcomeNegative'
  | 'conflictsWith'
  | 'pinned'
  | 'confidence'
  | 'content'
  | 'parents'
  | 'starred'
  | 'traceOutcome'
>;
type PlacementFields = Pick<
  MemoryEntry,
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
  | 'originProject'
  | 'descendantCount'
  | 'earliestAt'
  | 'latestAt'
  | 'summaryDirty'
  | 'lastRebuiltAt'
  | 'rebuildCount'
  | 'dagLevel3BuiltAt'
>;

function rowToRetrievalFields(row: MemoryRow): RetrievalFields {
  // SAFETY: every `as X` narrows a SQLite column to a MemoryEntry enum/union member; `row` comes from
  // MEMORY_SELECT_COLUMNS / MEMORY_SEARCH_COLUMNS, the only queries producing MemoryRow, and the DB layer writes these
  // columns only from the same enums.
  return {
    id: row.id,
    created: row.created,
    lastRetrieved: row.last_retrieved,
    retrievalCount: Number(row.retrieval_count ?? 0),
    strength: Number(row.strength ?? 1),
    halfLifeDays: Number(row.half_life_days ?? FALLBACK_HALF_LIFE_DAYS),
    layer: row.layer as Layer,
    tags: parseJsonArray(row.tags_json, { table: 'memories', id: row.id, column: 'tags_json' }),
    emotionalValence: row.emotional_valence ?? 'neutral',
    schemaFit: Number(row.schema_fit ?? DEFAULT_SCHEMA_FIT),
    source: row.source ?? 'cli',
    outcomeScore: row.outcome_score === null || row.outcome_score === undefined ? null : Number(row.outcome_score),
    outcomePositive: Number(row.outcome_positive ?? 0),
    outcomeNegative: Number(row.outcome_negative ?? 0),
    conflictsWith: parseJsonArray(row.conflicts_with_json, {
      table: 'memories',
      id: row.id,
      column: 'conflicts_with_json',
    }),
    pinned: Boolean(row.pinned),
    confidence: row.confidence ?? 'observed',
    content: row.content,
    parents: parseJsonArray(row.parents_json, { table: 'memories', id: row.id, column: 'parents_json' }),
    starred: Boolean(row.starred),
    traceOutcome: (row.trace_outcome as MemoryEntry['traceOutcome']) ?? null,
  };
}

function rowToPlacementFields(row: MemoryRow): PlacementFields {
  // SAFETY: the `as MemoryKind` narrows a column the DB layer only writes from that enum.
  return {
    sourceSessionId: row.source_session_id ?? null,
    validFrom: row.valid_from ?? row.created,
    supersededBy: row.superseded_by ?? null,
    extractedFrom: row.extracted_from ?? null,
    dagLevel: Number(row.dag_level ?? 0),
    dagParentId: row.dag_parent_id ?? null,
    kind: (row.kind ?? 'distilled') as MemoryKind,
    scope: row.scope ?? null,
    owner: row.owner ?? null,
    artifactRef: row.artifact_ref ?? null,
    tenantId: row.tenant_id ?? DEFAULT_TENANT_ID,
    originProject: row.origin_project ?? null,
    descendantCount: Number(row.descendant_count ?? 0),
    earliestAt: row.earliest_at ?? null,
    latestAt: row.latest_at ?? null,
    summaryDirty: Number(row.summary_dirty) === 1,
    lastRebuiltAt: row.last_rebuilt_at ?? null,
    rebuildCount: Number(row.rebuild_count ?? 0),
    dagLevel3BuiltAt: row.dag_level_3_built_at ?? null,
  };
}

export function rowToEntry(row: MemoryRow): MemoryEntry {
  const entry: MemoryEntry = { ...rowToRetrievalFields(row), ...rowToPlacementFields(row) };
  // Preserve bm25_score from the FTS path; `'bm25_score' in row` tells an absent column (non-FTS path) from a present
  // one.
  if ('bm25_score' in row && row.bm25_score !== undefined && row.bm25_score !== null) {
    entry.bm25Score = Number(row.bm25_score);
  }
  return entry;
}

/** A column that is not JSON reads as empty. With `site` the row is named at warn once; without it no row is known and
 * the line stays at debug. */
export function parseJsonArray(raw: string | null | undefined, site?: StoredJsonSite): string[] {
  if (!raw) return [];
  const parsed = tryParseJson(raw);
  if (parsed === undefined) {
    if (site) warnDamagedColumn(site, 'not valid JSON');
    else log.debug('store: corrupt JSON array column read as empty');
    return [];
  }
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
}

/** Strict parse for `last_trace_id`: Number(raw) turns '' or garbage into 0/NaN (a masked FK violation); require a
 * clean positive integer string, else unset. The ONE place that decides 'clean'; consumers read the validated value
 * from `buildIndexFromDb`'s result and never re-parse. */
export function parseLastTraceId(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) return null;
  return trimmed;
}

function parseJsonObject(raw: string | null | undefined, site: StoredJsonSite): Record<string, JsonValue> {
  if (!raw) return {};
  return parseStoredObject(site, raw) ?? {};
}

export function rowToTaskSnapshot(row: TaskSnapshotRow): TaskSnapshot {
  return {
    id: Number(row.id),
    task: row.task,
    summary: row.summary,
    next_step: row.next_step,
    status: row.status,
    source: row.source,
    session_id: row.session_id ?? null,
    scope: row.scope ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function rowToMemoryConflict(row: MemoryConflictRow): MemoryConflict {
  return {
    id: Number(row.id),
    memory_a_id: row.memory_a_id,
    memory_b_id: row.memory_b_id,
    reason: row.reason,
    score: Number(row.score ?? 0),
    status: row.status,
    detected_at: row.detected_at,
    updated_at: row.updated_at,
  };
}

export function rowToSessionEvent(row: SessionEventRow): SessionEvent {
  return {
    id: Number(row.id),
    session_id: row.session_id,
    task: row.task ?? null,
    event_type: row.event_type,
    content: row.content,
    source: row.source,
    scope: row.scope ?? null,
    metadata: parseJsonObject(row.metadata_json, { table: 'session_events', id: row.id, column: 'metadata_json' }),
    created_at: row.created_at,
  };
}
