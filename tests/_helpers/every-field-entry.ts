// One memory with every MemoryEntry field set to a value that is not its default, for the wire-format goldens.
import { Layer, type MemoryEntry } from '../../src/core/memory.js';

export const GOLDEN_TENANT = 'acme';

/** Every field set, in the order a store read builds them; superseded, scoped and a level-2 summary, so recall hides
 * it. */
export function everyFieldEntry(): MemoryEntry {
  return {
    id: 'mem-golden-every',
    created: '2026-01-10T09:00:00.000Z',
    last_retrieved: '2026-01-20T10:00:00.000Z',
    retrieval_count: 4,
    strength: 0.8125,
    half_life_days: 21,
    layer: Layer.Episodic,
    tags: ['wire', 'golden'],
    emotional_valence: 'positive',
    schema_fit: 0.65,
    source: 'cli',
    outcome_score: 0.5,
    outcome_positive: 3,
    outcome_negative: 1,
    conflicts_with: ['mem-golden-other'],
    pinned: true,
    confidence: 'observed',
    content: 'the wire golden keeps every stored key in its place',
    parents: ['mem-golden-parent'],
    starred: true,
    trace_outcome: 'success',
    source_session_id: 'sess-golden',
    valid_from: '2026-01-11T00:00:00.000Z',
    superseded_by: 'mem-golden-newer',
    extracted_from: 'mem-golden-source',
    dag_level: 2,
    dag_parent_id: 'mem-golden-topic',
    kind: 'distilled',
    scope: 'project:golden',
    owner: 'user:golden',
    artifact_ref: 'gh://kitfunso/hippo-memory/pull/1',
    tenant_id: GOLDEN_TENANT,
    origin_project: 'golden',
    descendant_count: 7,
    earliest_at: '2025-12-01T00:00:00.000Z',
    latest_at: '2026-01-09T00:00:00.000Z',
    summary_dirty: true,
    last_rebuilt_at: '2026-01-12T00:00:00.000Z',
    rebuild_count: 2,
    dag_level_3_built_at: '2026-01-13T00:00:00.000Z',
    bm25_score: -3.25,
  };
}

/** The same fields, less the four that hide a row from recall: supersession, a scope, a summary level, a project. */
export function recallableEntry(): MemoryEntry {
  return {
    ...everyFieldEntry(),
    id: 'mem-golden-recall',
    content: 'the haddock wire golden reads back through recall',
    superseded_by: null,
    scope: null,
    dag_level: 0,
    origin_project: '',
  };
}
