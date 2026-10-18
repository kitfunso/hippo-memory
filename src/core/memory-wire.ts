// The snake_case keys a memory carries in every file and wire format: export JSON, markdown mirrors, dormant
// snapshots and the eval kit. MemoryEntry renames its fields freely; these names are published and stay.
import type { ConfidenceLevel, EmotionalValence, Layer, MemoryEntry, MemoryKind, TraceOutcome } from './memory.js';

/** A memory as files and wire formats name it. Optional keys are the ones a stored entry may lack. */
export interface MemoryWire {
  id: string;
  created: string;
  last_retrieved: string;
  retrieval_count: number;
  strength: number;
  half_life_days: number;
  layer: Layer;
  tags: string[];
  emotional_valence: EmotionalValence;
  schema_fit: number;
  source: string;
  outcome_score: number | null;
  outcome_positive: number;
  outcome_negative: number;
  conflicts_with: string[];
  pinned: boolean;
  confidence: ConfidenceLevel;
  content: string;
  parents: string[];
  starred: boolean;
  trace_outcome: TraceOutcome;
  source_session_id: string | null;
  valid_from: string;
  superseded_by: string | null;
  extracted_from: string | null;
  dag_level: number;
  dag_parent_id: string | null;
  kind: MemoryKind;
  scope: string | null;
  owner: string | null;
  artifact_ref: string | null;
  tenant_id: string;
  origin_project?: string | null;
  descendant_count?: number;
  earliest_at?: string | null;
  latest_at?: string | null;
  summary_dirty?: boolean;
  last_rebuilt_at?: string | null;
  rebuild_count?: number;
  dag_level_3_built_at?: string | null;
  bm25_score?: number;
}

/** Keys in the order a store read builds an entry, so a dump of a loaded entry keeps the bytes 2.x wrote. */
export function toWire(entry: MemoryEntry): MemoryWire {
  return {
    id: entry.id,
    created: entry.created,
    last_retrieved: entry.last_retrieved,
    retrieval_count: entry.retrieval_count,
    strength: entry.strength,
    half_life_days: entry.half_life_days,
    layer: entry.layer,
    tags: entry.tags,
    emotional_valence: entry.emotional_valence,
    schema_fit: entry.schema_fit,
    source: entry.source,
    outcome_score: entry.outcome_score,
    outcome_positive: entry.outcome_positive,
    outcome_negative: entry.outcome_negative,
    conflicts_with: entry.conflicts_with,
    pinned: entry.pinned,
    confidence: entry.confidence,
    content: entry.content,
    parents: entry.parents,
    starred: entry.starred,
    trace_outcome: entry.trace_outcome,
    source_session_id: entry.source_session_id,
    valid_from: entry.valid_from,
    superseded_by: entry.superseded_by,
    extracted_from: entry.extracted_from,
    dag_level: entry.dag_level,
    dag_parent_id: entry.dag_parent_id,
    kind: entry.kind,
    scope: entry.scope,
    owner: entry.owner,
    artifact_ref: entry.artifact_ref,
    tenant_id: entry.tenant_id,
    origin_project: entry.origin_project,
    descendant_count: entry.descendant_count,
    earliest_at: entry.earliest_at,
    latest_at: entry.latest_at,
    summary_dirty: entry.summary_dirty,
    last_rebuilt_at: entry.last_rebuilt_at,
    rebuild_count: entry.rebuild_count,
    dag_level_3_built_at: entry.dag_level_3_built_at,
    bm25_score: entry.bm25_score,
  };
}

/** The entry a wire object names; a key the wire lacks stays undefined, as JSON.parse left it before. */
export function fromWire(wire: MemoryWire): MemoryEntry {
  return {
    id: wire.id,
    created: wire.created,
    last_retrieved: wire.last_retrieved,
    retrieval_count: wire.retrieval_count,
    strength: wire.strength,
    half_life_days: wire.half_life_days,
    layer: wire.layer,
    tags: wire.tags,
    emotional_valence: wire.emotional_valence,
    schema_fit: wire.schema_fit,
    source: wire.source,
    outcome_score: wire.outcome_score,
    outcome_positive: wire.outcome_positive,
    outcome_negative: wire.outcome_negative,
    conflicts_with: wire.conflicts_with,
    pinned: wire.pinned,
    confidence: wire.confidence,
    content: wire.content,
    parents: wire.parents,
    starred: wire.starred,
    trace_outcome: wire.trace_outcome,
    source_session_id: wire.source_session_id,
    valid_from: wire.valid_from,
    superseded_by: wire.superseded_by,
    extracted_from: wire.extracted_from,
    dag_level: wire.dag_level,
    dag_parent_id: wire.dag_parent_id,
    kind: wire.kind,
    scope: wire.scope,
    owner: wire.owner,
    artifact_ref: wire.artifact_ref,
    tenant_id: wire.tenant_id,
    origin_project: wire.origin_project,
    descendant_count: wire.descendant_count,
    earliest_at: wire.earliest_at,
    latest_at: wire.latest_at,
    summary_dirty: wire.summary_dirty,
    last_rebuilt_at: wire.last_rebuilt_at,
    rebuild_count: wire.rebuild_count,
    dag_level_3_built_at: wire.dag_level_3_built_at,
    bm25_score: wire.bm25_score,
  };
}
