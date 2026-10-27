import { DEFAULT_TENANT_ID } from '../util/tenant.js';
import {
  type MemoryEntry,
  Layer,
  DEFAULT_SCHEMA_FIT,
  type ConfidenceLevel,
  type MemoryKind,
} from './entry.js';
import { FALLBACK_HALF_LIFE_DAYS } from './strength.js';
import { fromWire, toWire, type MemoryWire } from './memory-wire.js';
import { dumpFrontmatter, parseFrontmatter } from '../util/yaml.js';
import { redactEntry } from '../util/secret-detect.js';

type FrontmatterValue = string | number | boolean | null | string[] | number[];

/**
 * Fixed-shape field set for `serializeEntry`'s frontmatter; tenant_id/origin_project are optional
 * so they stay absent from the YAML when unset.
 */
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
  valid_from: FrontmatterValue;
  superseded_by: FrontmatterValue;
  extracted_from: FrontmatterValue;
  dag_level: FrontmatterValue;
  dag_parent_id: FrontmatterValue;
  tenant_id?: FrontmatterValue;
  origin_project?: FrontmatterValue;
}

// Four decimal places: enough to tell two strengths apart, short enough to read in a mirror file.
const MIRROR_SCALE = 10_000;

/** A strength or score as every mirror file prints it. */
export function mirrorDecimal(value: number): number {
  return Math.round(value * MIRROR_SCALE) / MIRROR_SCALE;
}

/** The fields every mirror file carries; serializeEntry adds the optional ones. */
function entryFrontmatter(wire: MemoryWire): EntryFrontmatterFields {
  return {
    id: wire.id,
    created: wire.created,
    last_retrieved: wire.last_retrieved,
    retrieval_count: wire.retrieval_count,
    strength: mirrorDecimal(wire.strength),
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
    confidence: wire.confidence ?? 'observed',
    parents: wire.parents ?? [],
    starred: wire.starred ?? false,
    trace_outcome: wire.trace_outcome ?? null,
    source_session_id: wire.source_session_id ?? null,
    kind: wire.kind ?? 'distilled',
    scope: wire.scope ?? null,
    owner: wire.owner ?? null,
    artifact_ref: wire.artifact_ref ?? null,
    // A rebuild from these files must keep supersession and the DAG; deserializeEntry reads all
    // five.
    valid_from: wire.valid_from,
    superseded_by: wire.superseded_by,
    extracted_from: wire.extracted_from,
    dag_level: wire.dag_level,
    dag_parent_id: wire.dag_parent_id,
  };
}

/** Serialize a MemoryEntry's stored form to markdown with YAML frontmatter. */
export function serializeEntry(entry: MemoryEntry): string {
  const wire = toWire(redactEntry(entry));
  const frontmatter = entryFrontmatter(wire);
  // Emit tenant_id only when not 'default' to keep diffs clean for the dominant single-tenant case
  // (mirrors the plan's task 7 guidance).
  const tenantId = wire.tenant_id ?? DEFAULT_TENANT_ID;
  if (tenantId !== DEFAULT_TENANT_ID) {
    frontmatter['tenant_id'] = tenantId;
  }
  // v39: '' (user-global) and null (unknown, hidden by default) must both round-trip; only
  // undefined (unstamped) is omitted, so a rebuild stamps nothing it can read.
  if (wire.origin_project !== undefined) {
    frontmatter['origin_project'] = wire.origin_project;
  }
  // Spread into a fresh literal: dumpFrontmatter's Record<string, YamlValue> needs an index
  // signature, which the named interface does not structurally provide.
  const fm = dumpFrontmatter({ ...frontmatter });
  return `${fm}\n\n${wire.content}\n`;
}

/** Deserialize a markdown file to a MemoryEntry; `now` stamps a file that names no creation
 * time. */
export function deserializeEntry(raw: string, now: Date): MemoryEntry | null {
  const { data, content } = parseFrontmatter(raw);

  if (!data['id'] || !data['layer']) return null;

  return fromWire({
    ...scoringWireOf(data, now),
    content: content.trim(),
    ...lineageWireOf(data, now),
  });
}

type FrontmatterData = Record<string, FrontmatterValue>;

type LineageWire = Pick<
  MemoryWire,
  | 'parents'
  | 'starred'
  | 'trace_outcome'
  | 'source_session_id'
  | 'valid_from'
  | 'superseded_by'
  | 'extracted_from'
  | 'dag_level'
  | 'dag_parent_id'
  | 'kind'
  | 'scope'
  | 'owner'
  | 'artifact_ref'
  | 'tenant_id'
  | 'origin_project'
>;

function scoringWireOf(
  data: FrontmatterData,
  now: Date,
): Omit<MemoryWire, 'content' | keyof LineageWire> {
  // SAFETY: each `as X` narrows a raw YAML field to a MemoryWire union member; frontmatter is only
  // written by serializeEntry, so out-of-range values mean hand-edited files, which this parser may
  // accept (permissive parse).
  return {
    id: String(data['id']),
    created: String(data['created'] ?? now.toISOString()),
    last_retrieved: String(data['last_retrieved'] ?? now.toISOString()),
    retrieval_count: Number(data['retrieval_count'] ?? 0),
    strength: Number(data['strength'] ?? 1.0),
    half_life_days: Number(data['half_life_days'] ?? FALLBACK_HALF_LIFE_DAYS),
    layer: data['layer'] as Layer,
    tags: normalizeStringArray(data['tags']),
    emotional_valence: (data['emotional_valence'] as MemoryWire['emotional_valence']) ?? 'neutral',
    schema_fit: Number(data['schema_fit'] ?? DEFAULT_SCHEMA_FIT),
    source: String(data['source'] ?? 'cli'),
    outcome_score:
      data['outcome_score'] === null || data['outcome_score'] === undefined
        ? null
        : Number(data['outcome_score']),
    outcome_positive: Number(data['outcome_positive'] ?? 0),
    outcome_negative: Number(data['outcome_negative'] ?? 0),
    conflicts_with: normalizeStringArray(data['conflicts_with']),
    pinned: Boolean(data['pinned'] ?? false),
    confidence: (data['confidence'] as ConfidenceLevel) ?? 'observed',
  };
}

function lineageWireOf(data: FrontmatterData, now: Date): LineageWire {
  // SAFETY: each `as X` narrows a raw YAML field to a MemoryWire union member; frontmatter is only
  // written by serializeEntry, so out-of-range values mean hand-edited files, which this parser may
  // accept (permissive parse).
  return {
    parents: normalizeStringArray(data['parents']),
    starred: Boolean(data['starred'] ?? false),
    trace_outcome: (data['trace_outcome'] as MemoryWire['trace_outcome']) ?? null,
    source_session_id: nullableString(data['source_session_id']),
    valid_from: data['valid_from']
      ? String(data['valid_from'])
      : String(data['created'] ?? now.toISOString()),
    superseded_by: nullableString(data['superseded_by']),
    extracted_from: (data['extracted_from'] as string) ?? null,
    dag_level: Number(data['dag_level'] ?? 0),
    dag_parent_id: (data['dag_parent_id'] as string) ?? null,
    kind: (data['kind'] as MemoryKind) ?? 'distilled',
    scope: nullableString(data['scope']),
    owner: nullableString(data['owner']),
    artifact_ref: nullableString(data['artifact_ref']),
    tenant_id: nullableString(data['tenant_id']) ?? DEFAULT_TENANT_ID,
    origin_project: originProjectOf(data),
  };
}

function originProjectOf(data: Record<string, FrontmatterValue>): string | null | undefined {
  if (!('origin_project' in data)) return undefined;
  return data['origin_project'] === null ? null : String(data['origin_project']);
}

function nullableString(value: FrontmatterValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function normalizeStringArray(value: FrontmatterValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}
