import { type MemoryEntry, Layer, type ConfidenceLevel, type MemoryKind } from '../memory.js';
import { dumpFrontmatter, parseFrontmatter } from '../yaml.js';

type FrontmatterValue = string | number | boolean | null | string[] | number[];

/** Named field set for `serializeEntry`'s frontmatter — a fixed-shape owner
 * contract (not an open dictionary), with tenant_id/origin_project optional
 * so they can stay entirely absent from the YAML output when not set. */
interface EntryFrontmatterFields {
  id: FrontmatterValue;
  created: FrontmatterValue;
  last_retrieved: FrontmatterValue;
  retrieval_count: FrontmatterValue;
  strength: FrontmatterValue;
  half_life_days: FrontmatterValue;
  layer: FrontmatterValue;
  tags: FrontmatterValue;
  emotional_valence: FrontmatterValue;
  schema_fit: FrontmatterValue;
  source: FrontmatterValue;
  outcome_score: FrontmatterValue;
  outcome_positive: FrontmatterValue;
  outcome_negative: FrontmatterValue;
  conflicts_with: FrontmatterValue;
  pinned: FrontmatterValue;
  confidence: FrontmatterValue;
  parents: FrontmatterValue;
  starred: FrontmatterValue;
  trace_outcome: FrontmatterValue;
  source_session_id: FrontmatterValue;
  kind: FrontmatterValue;
  scope: FrontmatterValue;
  owner: FrontmatterValue;
  artifact_ref: FrontmatterValue;
  tenant_id?: FrontmatterValue;
  origin_project?: FrontmatterValue;
}

/**
 * Serialize a MemoryEntry to markdown with YAML frontmatter.
 */
export function serializeEntry(entry: MemoryEntry): string {
  const frontmatter: EntryFrontmatterFields = {
    id: entry.id,
    created: entry.created,
    last_retrieved: entry.last_retrieved,
    retrieval_count: entry.retrieval_count,
    strength: Math.round(entry.strength * 10000) / 10000,
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
    confidence: entry.confidence ?? 'observed',
    parents: entry.parents ?? [],
    starred: entry.starred ?? false,
    trace_outcome: entry.trace_outcome ?? null,
    source_session_id: entry.source_session_id ?? null,
    kind: entry.kind ?? 'distilled',
    scope: entry.scope ?? null,
    owner: entry.owner ?? null,
    artifact_ref: entry.artifact_ref ?? null,
  };
  // Emit tenant_id only when not 'default' to keep diffs clean for the dominant
  // single-tenant case (mirrors the plan's task 7 guidance).
  const tenantId = entry.tenantId ?? 'default';
  if (tenantId !== 'default') {
    frontmatter['tenant_id'] = tenantId;
  }
  // v39: '' (user-global) and null (unknown, hidden by default) must both round-trip;
  // only undefined (unstamped) is omitted, so a rebuild stamps nothing it can read.
  if (entry.origin_project !== undefined) {
    frontmatter['origin_project'] = entry.origin_project;
  }
  // Spread into a fresh object literal: dumpFrontmatter's Record<string,
  // YamlValue> parameter needs an index signature, which a named interface
  // reference (EntryFrontmatterFields) doesn't structurally provide even
  // though every property's value type already matches.
  const fm = dumpFrontmatter({ ...frontmatter });
  return `${fm}\n\n${entry.content}\n`;
}

/**
 * Deserialize a markdown file to a MemoryEntry.
 */
export function deserializeEntry(raw: string): MemoryEntry | null {
  const { data, content } = parseFrontmatter(raw);

  if (!data['id'] || !data['layer']) return null;

  // SAFETY: every `as X` below narrows a raw YAML frontmatter field to an
  // enum/union member of MemoryEntry; frontmatter is only ever written by
  // serializeEntry (whose own fields are typed), so out-of-range values here
  // would indicate hand-edited files, which this parser is not required to
  // reject — matches the pre-existing permissive-parse behavior.
  return {
    id: String(data['id']),
    created: String(data['created'] ?? new Date().toISOString()),
    last_retrieved: String(data['last_retrieved'] ?? new Date().toISOString()),
    retrieval_count: Number(data['retrieval_count'] ?? 0),
    strength: Number(data['strength'] ?? 1.0),
    half_life_days: Number(data['half_life_days'] ?? 7),
    layer: data['layer'] as Layer,
    tags: normalizeStringArray(data['tags']),
    emotional_valence: (data['emotional_valence'] as MemoryEntry['emotional_valence']) ?? 'neutral',
    schema_fit: Number(data['schema_fit'] ?? 0.5),
    source: String(data['source'] ?? 'cli'),
    outcome_score: data['outcome_score'] === null || data['outcome_score'] === undefined ? null : Number(data['outcome_score']),
    outcome_positive: Number(data['outcome_positive'] ?? 0),
    outcome_negative: Number(data['outcome_negative'] ?? 0),
    conflicts_with: normalizeStringArray(data['conflicts_with']),
    pinned: Boolean(data['pinned'] ?? false),
    confidence: (data['confidence'] as ConfidenceLevel) ?? 'observed',
    content: content.trim(),
    parents: normalizeStringArray(data['parents']),
    starred: Boolean(data['starred'] ?? false),
    trace_outcome: (data['trace_outcome'] as MemoryEntry['trace_outcome']) ?? null,
    source_session_id: data['source_session_id'] === null || data['source_session_id'] === undefined
      ? null
      : String(data['source_session_id']),
    valid_from: data['valid_from'] ? String(data['valid_from']) : String(data['created'] ?? new Date().toISOString()),
    superseded_by: data['superseded_by'] === null || data['superseded_by'] === undefined
      ? null
      : String(data['superseded_by']),
    extracted_from: (data['extracted_from'] as string) ?? null,
    dag_level: Number(data['dag_level'] ?? 0),
    dag_parent_id: (data['dag_parent_id'] as string) ?? null,
    kind: ((data['kind'] as MemoryKind) ?? 'distilled'),
    scope: data['scope'] === null || data['scope'] === undefined ? null : String(data['scope']),
    owner: data['owner'] === null || data['owner'] === undefined ? null : String(data['owner']),
    artifact_ref: data['artifact_ref'] === null || data['artifact_ref'] === undefined ? null : String(data['artifact_ref']),
    tenantId: data['tenant_id'] === null || data['tenant_id'] === undefined ? 'default' : String(data['tenant_id']),
    origin_project: !('origin_project' in data) ? undefined : data['origin_project'] === null ? null : String(data['origin_project']),
  };
}

function normalizeStringArray(value: FrontmatterValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}
