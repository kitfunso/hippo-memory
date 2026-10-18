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
    last_retrieved: entry.lastRetrieved,
    retrieval_count: entry.retrievalCount,
    strength: entry.strength,
    half_life_days: entry.halfLifeDays,
    layer: entry.layer,
    tags: entry.tags,
    emotional_valence: entry.emotionalValence,
    schema_fit: entry.schemaFit,
    source: entry.source,
    outcome_score: entry.outcomeScore,
    outcome_positive: entry.outcomePositive,
    outcome_negative: entry.outcomeNegative,
    conflicts_with: entry.conflictsWith,
    pinned: entry.pinned,
    confidence: entry.confidence,
    content: entry.content,
    parents: entry.parents,
    starred: entry.starred,
    trace_outcome: entry.traceOutcome,
    source_session_id: entry.sourceSessionId,
    valid_from: entry.validFrom,
    superseded_by: entry.supersededBy,
    extracted_from: entry.extractedFrom,
    dag_level: entry.dagLevel,
    dag_parent_id: entry.dagParentId,
    kind: entry.kind,
    scope: entry.scope,
    owner: entry.owner,
    artifact_ref: entry.artifactRef,
    tenant_id: entry.tenantId,
    origin_project: entry.originProject,
    descendant_count: entry.descendantCount,
    earliest_at: entry.earliestAt,
    latest_at: entry.latestAt,
    summary_dirty: entry.summaryDirty,
    last_rebuilt_at: entry.lastRebuiltAt,
    rebuild_count: entry.rebuildCount,
    dag_level_3_built_at: entry.dagLevel3BuiltAt,
    bm25_score: entry.bm25Score,
  };
}

/** The entry a wire object names; a key the wire lacks stays undefined, as JSON.parse left it before. */
export function fromWire(wire: MemoryWire): MemoryEntry {
  return {
    id: wire.id,
    created: wire.created,
    lastRetrieved: wire.last_retrieved,
    retrievalCount: wire.retrieval_count,
    strength: wire.strength,
    halfLifeDays: wire.half_life_days,
    layer: wire.layer,
    tags: wire.tags,
    emotionalValence: wire.emotional_valence,
    schemaFit: wire.schema_fit,
    source: wire.source,
    outcomeScore: wire.outcome_score,
    outcomePositive: wire.outcome_positive,
    outcomeNegative: wire.outcome_negative,
    conflictsWith: wire.conflicts_with,
    pinned: wire.pinned,
    confidence: wire.confidence,
    content: wire.content,
    parents: wire.parents,
    starred: wire.starred,
    traceOutcome: wire.trace_outcome,
    sourceSessionId: wire.source_session_id,
    validFrom: wire.valid_from,
    supersededBy: wire.superseded_by,
    extractedFrom: wire.extracted_from,
    dagLevel: wire.dag_level,
    dagParentId: wire.dag_parent_id,
    kind: wire.kind,
    scope: wire.scope,
    owner: wire.owner,
    artifactRef: wire.artifact_ref,
    tenantId: wire.tenant_id,
    originProject: wire.origin_project,
    descendantCount: wire.descendant_count,
    earliestAt: wire.earliest_at,
    latestAt: wire.latest_at,
    summaryDirty: wire.summary_dirty,
    lastRebuiltAt: wire.last_rebuilt_at,
    rebuildCount: wire.rebuild_count,
    dagLevel3BuiltAt: wire.dag_level_3_built_at,
    bm25Score: wire.bm25_score,
  };
}
