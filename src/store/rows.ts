import { Layer, FALLBACK_HALF_LIFE_DAYS, DEFAULT_SCHEMA_FIT, type MemoryEntry, type ConfidenceLevel, type MemoryKind } from '../core/memory.js';
import { errorMessage, log } from '../util/log.js';
import { type JsonValue, isJsonObject } from '../util/json.js';

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
  /** Id of the most recent recall_traces row written by getContext/cmdRecall, mirrored from the
   *  `last_trace_id` meta key like last_retrieval_ids. null when none was written (api.recall never sets it). */
  last_trace_id: string | null;
}

export interface MemoryRow {
  id: string;
  created: string;
  last_retrieved: string;
  retrieval_count: number;
  strength: number;
  half_life_days: number;
  layer: string;
  tags_json: string;
  emotional_valence: MemoryEntry['emotional_valence'];
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
  trace_outcome: MemoryEntry['trace_outcome'];
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
  // In MEMORY_SELECT_COLUMNS so every read path populates these alongside
  // descendant_count / earliest_at / latest_at.
  summary_dirty: number | null;
  last_rebuilt_at: string | null;
  rebuild_count: number | null;
  dag_level_3_built_at: string | null;
  // Present only on rows from MEMORY_SEARCH_COLUMNS (FTS path).
  // Other paths SELECT MEMORY_SELECT_COLUMNS, which does not include this.
  bm25_score?: number;
}

export interface ConsolidationRunRow {
  timestamp: string;
  decayed: number;
  merged: number;
  removed: number;
}

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

export interface TaskSnapshot {
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

export interface MemoryConflict {
  id: number;
  memory_a_id: string;
  memory_b_id: string;
  reason: string;
  score: number;
  status: string;
  detected_at: string;
  updated_at: string;
}

export interface SessionEvent {
  id: number;
  session_id: string;
  task: string | null;
  event_type: string;
  content: string;
  source: string;
  scope: string | null;
  metadata: Record<string, JsonValue>;
  created_at: string;
}

export const INDEX_VERSION = 3;
export const MEMORY_SELECT_COLUMNS = `id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, outcome_score, outcome_positive, outcome_negative, conflicts_with_json, pinned, confidence, content, parents_json, starred, trace_outcome, source_session_id, valid_from, superseded_by, extracted_from, dag_level, dag_parent_id, kind, scope, owner, artifact_ref, tenant_id, origin_project, descendant_count, earliest_at, latest_at, summary_dirty, last_rebuilt_at, rebuild_count, dag_level_3_built_at`;
// FTS-join columns for loadSearchRows: each is `m.<col> AS <col>` so rowToEntry's unqualified
// reads still work, and the trailing bm25(memories_fts) AS bm25_score carries the FTS rank.
export const MEMORY_SEARCH_COLUMNS = `m.id AS id, m.created AS created, m.last_retrieved AS last_retrieved, m.retrieval_count AS retrieval_count, m.strength AS strength, m.half_life_days AS half_life_days, m.layer AS layer, m.tags_json AS tags_json, m.emotional_valence AS emotional_valence, m.schema_fit AS schema_fit, m.source AS source, m.outcome_score AS outcome_score, m.outcome_positive AS outcome_positive, m.outcome_negative AS outcome_negative, m.conflicts_with_json AS conflicts_with_json, m.pinned AS pinned, m.confidence AS confidence, m.content AS content, m.parents_json AS parents_json, m.starred AS starred, m.trace_outcome AS trace_outcome, m.source_session_id AS source_session_id, m.valid_from AS valid_from, m.superseded_by AS superseded_by, m.extracted_from AS extracted_from, m.dag_level AS dag_level, m.dag_parent_id AS dag_parent_id, m.kind AS kind, m.scope AS scope, m.owner AS owner, m.artifact_ref AS artifact_ref, m.tenant_id AS tenant_id, m.origin_project AS origin_project, m.descendant_count AS descendant_count, m.earliest_at AS earliest_at, m.latest_at AS latest_at, m.summary_dirty AS summary_dirty, m.last_rebuilt_at AS last_rebuilt_at, m.rebuild_count AS rebuild_count, m.dag_level_3_built_at AS dag_level_3_built_at, bm25(memories_fts) AS bm25_score`;
/**
 * Default candidate-pool size for `loadSearchEntries` when called with
 * `limit === undefined`. Single source of truth; `api.recall` imports
 * this for `RecallResult.windowSize` reporting so the two cannot drift.
 */
export const DEFAULT_SEARCH_CANDIDATE_LIMIT = 200;

type RetrievalFields = Pick<MemoryEntry, 'id' | 'created' | 'last_retrieved' | 'retrieval_count' | 'strength' | 'half_life_days' | 'layer' | 'tags' | 'emotional_valence' | 'schema_fit' | 'source' | 'outcome_score' | 'outcome_positive' | 'outcome_negative' | 'conflicts_with' | 'pinned' | 'confidence' | 'content' | 'parents' | 'starred' | 'trace_outcome'>;
type PlacementFields = Pick<MemoryEntry, 'source_session_id' | 'valid_from' | 'superseded_by' | 'extracted_from' | 'dag_level' | 'dag_parent_id' | 'kind' | 'scope' | 'owner' | 'artifact_ref' | 'tenantId' | 'origin_project' | 'descendant_count' | 'earliest_at' | 'latest_at' | 'summary_dirty' | 'last_rebuilt_at' | 'rebuild_count' | 'dag_level_3_built_at'>;

function rowToRetrievalFields(row: MemoryRow): RetrievalFields {
  // SAFETY: every `as X` below narrows a SQLite column value to an
  // enum/union member of MemoryEntry; `row` comes from MEMORY_SELECT_COLUMNS
  // / MEMORY_SEARCH_COLUMNS, which are the only queries producing MemoryRow,
  // and the DB layer only ever writes these columns from the same enums.
  return {
    id: row.id,
    created: row.created,
    last_retrieved: row.last_retrieved,
    retrieval_count: Number(row.retrieval_count ?? 0),
    strength: Number(row.strength ?? 1),
    half_life_days: Number(row.half_life_days ?? FALLBACK_HALF_LIFE_DAYS),
    layer: row.layer as Layer,
    tags: parseJsonArray(row.tags_json),
    emotional_valence: row.emotional_valence ?? 'neutral',
    schema_fit: Number(row.schema_fit ?? DEFAULT_SCHEMA_FIT),
    source: row.source ?? 'cli',
    outcome_score: row.outcome_score === null || row.outcome_score === undefined ? null : Number(row.outcome_score),
    outcome_positive: Number(row.outcome_positive ?? 0),
    outcome_negative: Number(row.outcome_negative ?? 0),
    conflicts_with: parseJsonArray(row.conflicts_with_json),
    pinned: Boolean(row.pinned),
    confidence: row.confidence ?? 'observed',
    content: row.content,
    parents: parseJsonArray(row.parents_json),
    starred: Boolean(row.starred),
    trace_outcome: (row.trace_outcome as MemoryEntry['trace_outcome']) ?? null,
  };
}

function rowToPlacementFields(row: MemoryRow): PlacementFields {
  // SAFETY: the `as MemoryKind` narrows a column the DB layer only writes from that enum.
  return {
    source_session_id: row.source_session_id ?? null,
    valid_from: row.valid_from ?? row.created,
    superseded_by: row.superseded_by ?? null,
    extracted_from: row.extracted_from ?? null,
    dag_level: Number(row.dag_level ?? 0),
    dag_parent_id: row.dag_parent_id ?? null,
    kind: ((row.kind ?? 'distilled') as MemoryKind),
    scope: row.scope ?? null,
    owner: row.owner ?? null,
    artifact_ref: row.artifact_ref ?? null,
    tenantId: row.tenant_id ?? 'default',
    origin_project: row.origin_project ?? null,
    descendant_count: Number(row.descendant_count ?? 0),
    earliest_at: row.earliest_at ?? null,
    latest_at: row.latest_at ?? null,
    summary_dirty: (Number(row.summary_dirty ?? 0) === 1 ? 1 : 0) as 0 | 1,
    last_rebuilt_at: row.last_rebuilt_at ?? null,
    rebuild_count: Number(row.rebuild_count ?? 0),
    dag_level_3_built_at: row.dag_level_3_built_at ?? null,
  };
}

export function rowToEntry(row: MemoryRow): MemoryEntry {
  const entry: MemoryEntry = { ...rowToRetrievalFields(row), ...rowToPlacementFields(row) };
  // Preserve bm25_score from the FTS path; `'bm25_score' in row` tells an absent column
  // (non-FTS path) from a present one.
  if ('bm25_score' in row && row.bm25_score !== undefined && row.bm25_score !== null) {
    entry.bm25_score = Number(row.bm25_score);
  }
  return entry;
}

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch (err) {
    log.debug(`store: corrupt JSON array column read as empty: ${errorMessage(err)}`);
    return [];
  }
}

/**
 * Strict parse for the `last_trace_id` meta value.
 * A bare Number(raw) would turn '', whitespace, or garbage into a
 * usable-looking 0/NaN — a consumer INSERTing recall_trace_outcomes with
 * trace_id=0 would hit a masked FK violation (row id 0 never exists).
 * Require a clean positive integer string; anything else is treated as
 * unset. This is the ONE place that decides "clean" — every consumer of
 * `HippoIndex.last_trace_id` (outcomeForLastRecall, tests) reads the
 * already-validated value out of `buildIndexFromDb`'s result and never
 * re-parses the raw meta string itself.
 */
export function parseLastTraceId(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) return null;
  return trimmed;
}

function parseJsonObject(raw: string | null | undefined): Record<string, JsonValue> {
  if (!raw) return {};
  try {
    const parsed: JsonValue = JSON.parse(raw);
    if (isJsonObject(parsed)) {
      return parsed;
    }
    return {};
  } catch (err) {
    log.debug(`store: corrupt JSON object column read as empty: ${errorMessage(err)}`);
    return {};
  }
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
    metadata: parseJsonObject(row.metadata_json),
    created_at: row.created_at,
  };
}

/** Named field set for the legacy `stats.json` mirror — the only fields any
 * caller reads (see loadLegacyStatsFile's callers below). */
export interface LegacyStats {
  [key: string]: JsonValue;
  total_remembered: JsonValue;
  total_recalled: JsonValue;
  total_forgotten: JsonValue;
  consolidation_runs: JsonValue;
}
