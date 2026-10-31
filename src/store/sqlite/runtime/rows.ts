import { DEFAULT_TENANT_ID } from '../../../base/util/tenant.js';
import {
  Layer,
  type MemoryEntry,
  type ConfidenceLevel,
  type MemoryKind,
  DEFAULT_SCHEMA_FIT,
  type EmotionalValence,
  type TraceOutcome,
} from '../../../base/memory/entry.js';
import { FALLBACK_HALF_LIFE_DAYS } from '../../../base/memory/strength.js';
import { log } from '../../../base/util/log.js';
import { type JsonValue, tryParseJson } from '../../../base/util/json.js';
import {
  parseStoredObject,
  warnDamagedColumn,
  type StoredJsonSite,
} from '../../../base/util/stored-json.js';
import type { SessionEvent, TaskSnapshot } from '../../../base/records/sessions.js';
import type { ConflictWire, MemoryConflict } from '../../../base/memory/conflict-wire.js';
import type { TaskSnapshotJson } from '../../../base/session/continuity-json.js';

// The memories columns' defaults, once: hippo.db applies them reading a row back.

type Count = number | null | undefined;
type Flag = boolean | number | null | undefined;
type Text = string | null | undefined;

/** A memories row in MemoryEntry's names, its JSON lists parsed; each column with a default may
 * be absent or null. */
interface StoredColumns extends Pick<
  MemoryEntry,
  'id' | 'created' | 'lastRetrieved' | 'layer' | 'content' | 'tenantId'
> {
  readonly tags: string[];
  readonly conflictsWith: string[];
  readonly parents: string[];
  readonly retrievalCount?: Count;
  readonly strength?: Count;
  readonly halfLifeDays?: Count;
  readonly schemaFit?: Count;
  readonly outcomeScore?: Count;
  readonly outcomePositive?: Count;
  readonly outcomeNegative?: Count;
  readonly dagLevel?: Count;
  readonly descendantCount?: Count;
  readonly rebuildCount?: Count;
  readonly pinned?: Flag;
  readonly starred?: Flag;
  readonly summaryDirty?: Flag;
  readonly emotionalValence?: EmotionalValence | null;
  readonly source?: Text;
  readonly confidence?: ConfidenceLevel | null;
  readonly traceOutcome?: TraceOutcome | null;
  readonly kind?: MemoryKind | null;
  readonly validFrom?: Text;
  readonly sourceSessionId?: Text;
  readonly supersededBy?: Text;
  readonly extractedFrom?: Text;
  readonly dagParentId?: Text;
  readonly scope?: Text;
  readonly owner?: Text;
  readonly artifactRef?: Text;
  readonly originProject?: Text;
  readonly earliestAt?: Text;
  readonly latestAt?: Text;
  readonly lastRebuiltAt?: Text;
  readonly dagLevel3BuiltAt?: Text;
}

function retrievalFields(c: StoredColumns) {
  return {
    id: c.id,
    created: c.created,
    lastRetrieved: c.lastRetrieved,
    retrievalCount: Number(c.retrievalCount ?? 0),
    strength: Number(c.strength ?? 1),
    halfLifeDays: Number(c.halfLifeDays ?? FALLBACK_HALF_LIFE_DAYS),
    layer: c.layer,
    tags: c.tags,
    emotionalValence: c.emotionalValence ?? 'neutral',
    schemaFit: Number(c.schemaFit ?? DEFAULT_SCHEMA_FIT),
    source: c.source ?? 'cli',
    outcomeScore:
      c.outcomeScore === null || c.outcomeScore === undefined ? null : Number(c.outcomeScore),
    outcomePositive: Number(c.outcomePositive ?? 0),
    outcomeNegative: Number(c.outcomeNegative ?? 0),
    conflictsWith: c.conflictsWith,
    pinned: Boolean(c.pinned),
    confidence: c.confidence ?? 'observed',
    content: c.content,
    parents: c.parents,
    starred: Boolean(c.starred),
    traceOutcome: c.traceOutcome ?? null,
  } satisfies Partial<MemoryEntry>;
}

function placementFields(c: StoredColumns) {
  return {
    sourceSessionId: c.sourceSessionId ?? null,
    validFrom: c.validFrom ?? c.created,
    supersededBy: c.supersededBy ?? null,
    extractedFrom: c.extractedFrom ?? null,
    dagLevel: Number(c.dagLevel ?? 0),
    dagParentId: c.dagParentId ?? null,
    kind: c.kind ?? 'distilled',
    scope: c.scope ?? null,
    owner: c.owner ?? null,
    artifactRef: c.artifactRef ?? null,
    tenantId: c.tenantId,
    originProject: c.originProject ?? null,
    descendantCount: Number(c.descendantCount ?? 0),
    earliestAt: c.earliestAt ?? null,
    latestAt: c.latestAt ?? null,
    summaryDirty: Number(c.summaryDirty ?? 0) === 1,
    lastRebuiltAt: c.lastRebuiltAt ?? null,
    rebuildCount: Number(c.rebuildCount ?? 0),
    dagLevel3BuiltAt: c.dagLevel3BuiltAt ?? null,
  } satisfies Partial<MemoryEntry>;
}

/** The entry a memories row reads back as, each unset column at hippo.db's default. */
function storedEntry(c: StoredColumns): MemoryEntry {
  return { ...retrievalFields(c), ...placementFields(c) };
}

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
  /** Id of the most recent recall_traces row written by contextGet/printRecall, mirrored from the `last_trace_id` meta
   *  key like last_retrieval_ids. null when none was written (api.recall never sets it). */
  last_trace_id: string | null;
}

// SAFETY: every read cast to this row selects MEMORY_SELECT_COLUMNS or MEMORY_SEARCH_COLUMNS.
// scripts/checks/check-row-casts.mjs proves it.
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
  // In MEMORY_SELECT_COLUMNS so every read path populates these alongside descendant_count /
  // earliest_at / latest_at.
  summary_dirty: number | null;
  last_rebuilt_at: string | null;
  rebuild_count: number | null;
  dag_level_3_built_at: string | null;
}

// SAFETY: every read cast to this row selects all its keys; scripts/checks/check-row-casts.mjs proves it.
export interface ConsolidationRunRow {
  timestamp: string;
  decayed: number;
  merged: number;
  removed: number;
}

export const TASK_SNAPSHOT_COLUMNS =
  'id, task, summary, next_step, status, source, session_id, scope, created_at, updated_at';

export const MEMORY_CONFLICT_COLUMNS =
  'id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at';

// SAFETY: every read cast to this row selects SESSION_EVENT_COLUMNS; scripts/checks/check-row-casts.mjs
// proves it.
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
/** The columns a row write sets, in memoryRowValues' order; the upsert and the batch update
 * share it. */
export const MEMORY_ROW_COLUMNS = [
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
  'dag_level_3_built_at',
] as const;
// Rebuild-queue columns the DAG summary rebuild writes (consolidation/consolidation.ts); a row write
// never sets them.
const MEMORY_COLUMN_NAMES = [
  ...MEMORY_ROW_COLUMNS,
  'summary_dirty',
  'last_rebuilt_at',
  'rebuild_count',
] as const;

// FTS-join columns for listSearchRows: `m.<col> AS <col>` keeps rowToEntry's unqualified reads
// working.
export const MEMORY_SELECT_COLUMNS = MEMORY_COLUMN_NAMES.join(', ');
export const MEMORY_SEARCH_COLUMNS = MEMORY_COLUMN_NAMES.map((c) => `m.${c} AS ${c}`).join(', ');

function retrievalColumnsOf(row: MemoryRow) {
  const site = (column: string): StoredJsonSite => ({ table: 'memories', id: row.id, column });
  // SAFETY: every `as X` narrows a SQLite column to a MemoryEntry enum/union member; `row` comes
  // from MEMORY_SELECT_COLUMNS / MEMORY_SEARCH_COLUMNS, and the DB layer writes these columns only
  // from the same enums.
  return {
    id: row.id,
    created: row.created,
    lastRetrieved: row.last_retrieved,
    retrievalCount: row.retrieval_count,
    strength: row.strength,
    halfLifeDays: row.half_life_days,
    layer: row.layer as Layer,
    tags: parseJsonArray(row.tags_json, site('tags_json')),
    emotionalValence: row.emotional_valence,
    schemaFit: row.schema_fit,
    source: row.source,
    outcomeScore: row.outcome_score,
    outcomePositive: row.outcome_positive,
    outcomeNegative: row.outcome_negative,
    conflictsWith: parseJsonArray(row.conflicts_with_json, site('conflicts_with_json')),
    pinned: row.pinned,
    confidence: row.confidence,
    content: row.content,
    parents: parseJsonArray(row.parents_json, site('parents_json')),
    starred: row.starred,
    traceOutcome: row.trace_outcome as MemoryEntry['traceOutcome'],
  } satisfies Partial<StoredColumns>;
}

function placementColumnsOf(row: MemoryRow) {
  return {
    sourceSessionId: row.source_session_id,
    validFrom: row.valid_from,
    supersededBy: row.superseded_by,
    extractedFrom: row.extracted_from,
    dagLevel: row.dag_level,
    dagParentId: row.dag_parent_id,
    // SAFETY: the DB layer writes `kind` only from MemoryKind.
    kind: row.kind as MemoryKind | null,
    scope: row.scope,
    owner: row.owner,
    artifactRef: row.artifact_ref,
    tenantId: row.tenant_id ?? DEFAULT_TENANT_ID,
    originProject: row.origin_project,
    descendantCount: row.descendant_count,
    earliestAt: row.earliest_at,
    latestAt: row.latest_at,
    summaryDirty: row.summary_dirty,
    lastRebuiltAt: row.last_rebuilt_at,
    rebuildCount: row.rebuild_count,
    dagLevel3BuiltAt: row.dag_level_3_built_at,
  } satisfies Partial<StoredColumns>;
}

/** The row in MemoryEntry's names, its JSON lists parsed; storedEntry fills each default. */
function storedColumnsOf(row: MemoryRow): StoredColumns {
  return { ...retrievalColumnsOf(row), ...placementColumnsOf(row) };
}

export function rowToEntry(row: MemoryRow): MemoryEntry {
  return storedEntry(storedColumnsOf(row));
}

/** A column that is not JSON reads as empty. With `site` the row is named at warn once; without
 * it no row is known and the line stays at debug. */
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

/** Strict parse for `last_trace_id`: Number(raw) turns '' or garbage into 0/NaN (a masked FK
 * violation); require a clean positive integer string, else unset. The ONE place that decides
 * 'clean'; consumers read the validated value from `buildIndexFromDb`'s result and never
 * re-parse. */
export function parseLastTraceId(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) return null;
  return trimmed;
}

function parseJsonObject(
  raw: string | null | undefined,
  site: StoredJsonSite,
): Record<string, JsonValue> {
  if (!raw) return {};
  return parseStoredObject(site, raw) ?? {};
}

export function rowToTaskSnapshot(row: TaskSnapshotJson): TaskSnapshot {
  return {
    id: Number(row.id),
    task: row.task,
    summary: row.summary,
    nextStep: row.next_step,
    status: row.status,
    source: row.source,
    sessionId: row.session_id ?? null,
    scope: row.scope ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToMemoryConflict(row: ConflictWire): MemoryConflict {
  return {
    id: Number(row.id),
    memoryAId: row.memory_a_id,
    memoryBId: row.memory_b_id,
    reason: row.reason,
    score: Number(row.score ?? 0),
    status: row.status,
    detectedAt: row.detected_at,
    updatedAt: row.updated_at,
  };
}

export function rowToSessionEvent(row: SessionEventRow): SessionEvent {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    task: row.task ?? null,
    eventType: row.event_type,
    content: row.content,
    source: row.source,
    scope: row.scope ?? null,
    metadata: parseJsonObject(row.metadata_json, {
      table: 'session_events',
      id: row.id,
      column: 'metadata_json',
    }),
    createdAt: row.created_at,
  };
}
