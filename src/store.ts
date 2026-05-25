/**
 * Storage layer for Hippo.
 *
 * SQLite is the source of truth.
 * Markdown + JSON files remain as human-readable compatibility mirrors.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MemoryEntry, Layer, ConfidenceLevel, MemoryKind } from './memory.js';
import { dumpFrontmatter, parseFrontmatter } from './yaml.js';
import {
  openHippoDb,
  closeHippoDb,
  getMeta,
  setMeta,
  isFtsAvailable,
  pruneConsolidationRuns,
  getHippoDbPath,
  type DatabaseSyncLike,
} from './db.js';
import { SessionHandoff, SessionHandoffRow, rowToSessionHandoff } from './handoff.js';
import { tokenize } from './search.js';
import { appendAuditEvent, type AuditOp } from './audit.js';
import { resolveTenantId } from './tenant.js';

/**
 * Emit an audit event for a mutation against `db`. Wrapped so a broken audit
 * log can never crash the surrounding mutation — the SQLite store is still the
 * source of truth and audit failures are diagnosable from the missing rows.
 */
function audit(
  db: ReturnType<typeof openHippoDb>,
  op: AuditOp,
  targetId?: string,
  metadata?: Record<string, unknown>,
  actor: string = 'cli',
  tenantId?: string,
): void {
  try {
    appendAuditEvent(db, {
      tenantId: tenantId ?? resolveTenantId({}),
      actor,
      op,
      targetId,
      metadata,
    });
  } catch {
    // Audit must never crash a mutation. Failures here mean the audit_log
    // table is broken; the mutation has already succeeded.
  }
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
}

interface MemoryRow {
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
  descendant_count: number | null;
  earliest_at: string | null;
  latest_at: string | null;
  // v0.30 / E1 of DAG live-coupling (schema v28). Symmetric with v25 DAG
  // cache: included in MEMORY_SELECT_COLUMNS so every read path populates
  // these alongside descendant_count / earliest_at / latest_at.
  summary_dirty: number | null;
  last_rebuilt_at: string | null;
  rebuild_count: number | null;
  dag_level_3_built_at: string | null;
  // F1 (v1.7.0): present only on rows from MEMORY_SEARCH_COLUMNS (FTS path).
  // Other paths SELECT MEMORY_SELECT_COLUMNS, which does not include this.
  bm25_score?: number;
}

interface ConsolidationRunRow {
  timestamp: string;
  decayed: number;
  merged: number;
  removed: number;
}

interface TaskSnapshotRow {
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

interface MemoryConflictRow {
  id: number;
  memory_a_id: string;
  memory_b_id: string;
  reason: string;
  score: number;
  status: string;
  detected_at: string;
  updated_at: string;
}

interface SessionEventRow {
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
  metadata: Record<string, unknown>;
  created_at: string;
}

const INDEX_VERSION = 3;
const MEMORY_SELECT_COLUMNS = `id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, outcome_score, outcome_positive, outcome_negative, conflicts_with_json, pinned, confidence, content, parents_json, starred, trace_outcome, source_session_id, valid_from, superseded_by, extracted_from, dag_level, dag_parent_id, kind, scope, owner, artifact_ref, tenant_id, descendant_count, earliest_at, latest_at, summary_dirty, last_rebuilt_at, rebuild_count, dag_level_3_built_at`;
// F1 (v1.7.0): qualified-and-aliased columns for the FTS join in
// loadSearchRows. Every column is `m.<col> AS <col>` so rowToEntry's
// unqualified field reads keep working unchanged. The trailing
// bm25(memories_fts) AS bm25_score adds the FTS rank as a result column.
// Only used inside the FTS path; non-FTS paths keep MEMORY_SELECT_COLUMNS.
const MEMORY_SEARCH_COLUMNS = `m.id AS id, m.created AS created, m.last_retrieved AS last_retrieved, m.retrieval_count AS retrieval_count, m.strength AS strength, m.half_life_days AS half_life_days, m.layer AS layer, m.tags_json AS tags_json, m.emotional_valence AS emotional_valence, m.schema_fit AS schema_fit, m.source AS source, m.outcome_score AS outcome_score, m.outcome_positive AS outcome_positive, m.outcome_negative AS outcome_negative, m.conflicts_with_json AS conflicts_with_json, m.pinned AS pinned, m.confidence AS confidence, m.content AS content, m.parents_json AS parents_json, m.starred AS starred, m.trace_outcome AS trace_outcome, m.source_session_id AS source_session_id, m.valid_from AS valid_from, m.superseded_by AS superseded_by, m.extracted_from AS extracted_from, m.dag_level AS dag_level, m.dag_parent_id AS dag_parent_id, m.kind AS kind, m.scope AS scope, m.owner AS owner, m.artifact_ref AS artifact_ref, m.tenant_id AS tenant_id, m.descendant_count AS descendant_count, m.earliest_at AS earliest_at, m.latest_at AS latest_at, m.summary_dirty AS summary_dirty, m.last_rebuilt_at AS last_rebuilt_at, m.rebuild_count AS rebuild_count, m.dag_level_3_built_at AS dag_level_3_built_at, bm25(memories_fts) AS bm25_score`;
/**
 * Default candidate-pool size for `loadSearchEntries` when called with
 * `limit === undefined`. Single source of truth; `api.recall` imports
 * this for `RecallResult.windowSize` reporting so the two cannot drift.
 */
export const DEFAULT_SEARCH_CANDIDATE_LIMIT = 200;

/**
 * v1.7.2 — literal scopes excluded from recall by default-deny when the
 * caller passes no `scope`. The SQL clause in `loadSearchRows` and the JS
 * helper `passesScopeFilterForRecall` (src/api.ts) both read from this
 * constant. Adding a deny scope is a one-place change.
 *
 * Regex-based denies (e.g. `<source>:private:*`) stay in
 * `passesScopeFilterForRecall` as a separate JS step — they don't translate
 * cleanly to SQL.
 *
 * Invariant: never empty. An empty array would silently allow quarantine
 * scopes through both paths (SQL clause omitted, JS check vacuous). The
 * module-load assertion below pins this loudly.
 */
export const RECALL_DEFAULT_DENY_SCOPES = ['unknown:legacy'] as const;

/**
 * @internal v1.7.3 — runtime guard against a future maintainer blanking a
 * load-bearing literal array. Extracted from the inline guard so the throw
 * path is directly testable. `as const` arrays widen via `readonly T[]` at
 * the call site so the empty case is reachable at runtime.
 */
export function assertNonEmpty<T>(arr: readonly T[], name: string): void {
  if (arr.length === 0) {
    throw new Error(
      `${name} cannot be empty — would silently allow quarantine scopes`,
    );
  }
}

assertNonEmpty(
  RECALL_DEFAULT_DENY_SCOPES as readonly string[],
  'RECALL_DEFAULT_DENY_SCOPES',
);

function layerDir(root: string, layer: Layer): string {
  return path.join(root, layer);
}

export function getHippoRoot(cwd: string = process.cwd()): string {
  return path.join(cwd, '.hippo');
}

export function isInitialized(hippoRoot: string): boolean {
  // A bare .hippo directory is not enough — autoInstallHooks /
  // setupDailySchedule can create it without ever calling initStore,
  // leaving a partial directory (integrations/, logs/, runs/) with no
  // hippo.db. Returning true in that state caused `hippo init` to skip
  // initStore and `hippo recall` to silently fall back to an empty store
  // (incident 2026-04-26: ingest_direct.py against a bare .hippo).
  // Treat the store as initialized only if hippo.db actually exists.
  return fs.existsSync(path.join(hippoRoot, 'hippo.db'));
}

export function initStore(hippoRoot: string): void {
  ensureMirrorDirectories(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const bootstrapped = bootstrapLegacyStore(db, hippoRoot);
    if (bootstrapped) {
      syncMirrorFiles(hippoRoot, db);
    }
  } finally {
    closeHippoDb(db);
  }
}

function ensureMirrorDirectories(hippoRoot: string): void {
  const dirs = [
    hippoRoot,
    path.join(hippoRoot, 'buffer'),
    path.join(hippoRoot, 'episodic'),
    path.join(hippoRoot, 'semantic'),
    path.join(hippoRoot, 'conflicts'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Serialize a MemoryEntry to markdown with YAML frontmatter.
 */
export function serializeEntry(entry: MemoryEntry): string {
  const frontmatter: Record<string, string | number | boolean | null | string[] | number[]> = {
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
  const fm = dumpFrontmatter(frontmatter);
  return `${fm}\n\n${entry.content}\n`;
}

/**
 * Deserialize a markdown file to a MemoryEntry.
 */
export function deserializeEntry(raw: string): MemoryEntry | null {
  const { data, content } = parseFrontmatter(raw);

  if (!data['id'] || !data['layer']) return null;

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
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    created: row.created,
    last_retrieved: row.last_retrieved,
    retrieval_count: Number(row.retrieval_count ?? 0),
    strength: Number(row.strength ?? 1),
    half_life_days: Number(row.half_life_days ?? 7),
    layer: row.layer as Layer,
    tags: parseJsonArray(row.tags_json),
    emotional_valence: row.emotional_valence ?? 'neutral',
    schema_fit: Number(row.schema_fit ?? 0.5),
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
    descendant_count: Number(row.descendant_count ?? 0),
    earliest_at: row.earliest_at ?? null,
    latest_at: row.latest_at ?? null,
    // v0.30 / E1 of DAG live-coupling (schema v28). Symmetric with v25 cache.
    summary_dirty: (Number(row.summary_dirty ?? 0) === 1 ? 1 : 0) as 0 | 1,
    last_rebuilt_at: row.last_rebuilt_at ?? null,
    rebuild_count: Number(row.rebuild_count ?? 0),
    dag_level_3_built_at: row.dag_level_3_built_at ?? null,
    // F1 (v1.7.0): preserve bm25_score from the FTS path. `'bm25_score' in row`
    // distinguishes "absent column" (non-FTS path) from "column present but
    // value 0" — though FTS5 bm25() never returns 0, this is defensive.
    ...('bm25_score' in row && row.bm25_score !== undefined && row.bm25_score !== null
      ? { bm25_score: Number(row.bm25_score) }
      : {}),
  };
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function rowToTaskSnapshot(row: TaskSnapshotRow): TaskSnapshot {
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

function rowToMemoryConflict(row: MemoryConflictRow): MemoryConflict {
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

function rowToSessionEvent(row: SessionEventRow): SessionEvent {
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

// Tenant-scoped mirror file paths. The single-tenant 'default' deployment
// keeps the original `active-task.md` / `recent-session.md` filenames for
// on-disk back-compat; multi-tenant deployments get a `.<tenantId>` suffix
// so tenant B saving cannot overwrite tenant A's mirror file.
function activeTaskMirrorPath(hippoRoot: string, tenantId: string): string {
  const file = tenantId === 'default' ? 'active-task.md' : `active-task.${tenantId}.md`;
  return path.join(hippoRoot, 'buffer', file);
}

function recentSessionMirrorPath(hippoRoot: string, tenantId: string): string {
  const file = tenantId === 'default' ? 'recent-session.md' : `recent-session.${tenantId}.md`;
  return path.join(hippoRoot, 'buffer', file);
}

function writeActiveTaskMirror(hippoRoot: string, tenantId: string, snapshot: TaskSnapshot): void {
  const filePath = activeTaskMirrorPath(hippoRoot, tenantId);
  const fm = dumpFrontmatter({
    id: snapshot.id,
    task: snapshot.task,
    status: snapshot.status,
    source: snapshot.source,
    session_id: snapshot.session_id,
    created_at: snapshot.created_at,
    updated_at: snapshot.updated_at,
    next_step: snapshot.next_step,
  });

  const body = [
    `# Active Task Snapshot`,
    '',
    `## Summary`,
    snapshot.summary,
    '',
    `## Next step`,
    snapshot.next_step,
    '',
    `## Task`,
    snapshot.task,
    '',
  ];

  if (snapshot.session_id) {
    body.push(`## Session`, snapshot.session_id, '');
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${fm}\n\n${body.join('\n')}`, 'utf8');
}

function removeActiveTaskMirror(hippoRoot: string, tenantId: string): void {
  const filePath = activeTaskMirrorPath(hippoRoot, tenantId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function writeRecentSessionMirror(hippoRoot: string, tenantId: string, events: SessionEvent[]): void {
  const filePath = recentSessionMirrorPath(hippoRoot, tenantId);
  if (events.length === 0) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }

  const latest = events[events.length - 1]!;
  const fm = dumpFrontmatter({
    session_id: latest.session_id,
    task: latest.task,
    event_count: events.length,
    updated_at: latest.created_at,
  });

  const lines = [
    '# Recent Session Trail',
    '',
    `- Session: ${latest.session_id}`,
    `- Task: ${latest.task ?? 'n/a'}`,
    `- Updated: ${latest.created_at}`,
    '',
    '## Events',
    '',
  ];

  for (const event of events) {
    lines.push(`- [${event.created_at}] (${event.event_type}) ${event.content}`);
  }

  lines.push('');

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${fm}\n\n${lines.join('\n')}`, 'utf8');
}

function writeConflictMirrors(hippoRoot: string, conflicts: MemoryConflict[]): void {
  const conflictDir = path.join(hippoRoot, 'conflicts');
  fs.mkdirSync(conflictDir, { recursive: true });

  const keep = new Set<string>();
  for (const conflict of conflicts) {
    const filename = `conflict_${conflict.id}.md`;
    keep.add(filename);

    const fm = dumpFrontmatter({
      id: conflict.id,
      memory_a_id: conflict.memory_a_id,
      memory_b_id: conflict.memory_b_id,
      reason: conflict.reason,
      score: Math.round(conflict.score * 10000) / 10000,
      status: conflict.status,
      detected_at: conflict.detected_at,
      updated_at: conflict.updated_at,
    });

    const body = [
      '# Memory Conflict',
      '',
      `- Memory A: ${conflict.memory_a_id}`,
      `- Memory B: ${conflict.memory_b_id}`,
      `- Reason: ${conflict.reason}`,
      `- Score: ${conflict.score.toFixed(3)}`,
      `- Status: ${conflict.status}`,
      '',
    ].join('\n');

    fs.writeFileSync(path.join(conflictDir, filename), `${fm}\n\n${body}`, 'utf8');
  }

  for (const existing of fs.readdirSync(conflictDir)) {
    if (existing === '.gitkeep') continue;
    if (!keep.has(existing)) {
      fs.unlinkSync(path.join(conflictDir, existing));
    }
  }
}

function canonicalConflictPair(aId: string, bId: string): { memory_a_id: string; memory_b_id: string } {
  return aId < bId
    ? { memory_a_id: aId, memory_b_id: bId }
    : { memory_a_id: bId, memory_b_id: aId };
}

/**
 * v1.7.2 — recall-mode scope filter shape, exported so callers
 * (`loadRecallSearchEntries`) and tests can refer to it symbolically without
 * `Parameters<typeof loadSearchRows>[N]` indirection.
 *
 * Two modes:
 *   - 'default-deny' — exclude scopes in `RECALL_DEFAULT_DENY_SCOPES` (T2).
 *   - 'exact' — exact match on `m.scope = value`.
 *
 * Background pipelines (`consolidate`, `embeddings`, `refine-llm`, ...) call
 * `loadSearchEntries` (no scopeFilter arg) and see all rows including
 * quarantine.
 */
/** @internal v1.7.2 — internal SQL-builder shape; not on the public API
 *  surface (not re-exported from `src/index.ts`). Subject to change. */
export type RecallScopeFilter =
  | { mode: 'default-deny' }
  | { mode: 'exact'; value: string };

function loadSearchRows(
  db: ReturnType<typeof openHippoDb>,
  query: string,
  limit: number,
  tenantId: string | undefined,
  scopeFilter?: RecallScopeFilter,
): MemoryRow[] {
  // tenantId undefined = no tenant filter (legacy callers / cross-deployment
  // helpers). tenantId set = strict tenant isolation, leveraging the composite
  // idx_memories_tenant_created (leading column tenant_id, O(log n) lookup).
  const tenantPredicate = tenantId !== undefined ? ` AND m.tenant_id = ?` : '';
  const tenantPredicateNoAlias = tenantId !== undefined ? ` AND tenant_id = ?` : '';
  const tenantOnlyPredicate = tenantId !== undefined ? ` WHERE tenant_id = ?` : '';
  const tenantParams = tenantId !== undefined ? [tenantId] : [];

  // v1.12.6 — belt-and-suspenders against `kind='archived'` leaking into recall.
  // `kind='archived'` is a transient sentinel inside `archiveRawMemory`'s
  // SAVEPOINT (src/raw-archive.ts:56): UPDATE kind = 'archived' immediately
  // followed by DELETE, both inside one savepoint that commits or rolls back
  // atomically. SQLite atomicity guarantees no concurrent reader sees the
  // intermediate state. This filter is defensive-only against:
  //   (a) future bugs that drop the SAVEPOINT,
  //   (b) future bugs that introduce kind='archived' as a persisted state,
  //   (c) external direct-SQL writes that bypass archiveRawMemory.
  // tenantOnlyPredicate starts with " WHERE tenant_id = ?" when tenant is set;
  // when unset, we have no WHERE yet, so the archived clause needs both AND
  // and WHERE forms. The "tenant-only" path always has WHERE (from tenant or
  // we synthesize one).
  const archivedClauseAlias = ` AND m.kind != 'archived'`;
  const archivedClauseNoAlias = ` AND kind != 'archived'`;
  // For the "tenant-only" path: if no tenant set, tenantOnlyPredicate is '',
  // so prepend WHERE; if tenant set, append AND. handled in each call site
  // by always joining `tenantOnlyPredicate + archivedClauseTenantOnly` where
  // the latter switches between " AND" and " WHERE" based on caller context.
  const archivedClauseTenantOnly =
    tenantId !== undefined ? ` AND kind != 'archived'` : ` WHERE kind != 'archived'`;

  // v1.7.1 — recall-mode scope predicate (root-cause fix for the
  // `unknown:legacy` leak codex flagged on the v1.6.5 review). Three forms:
  //   undefined       → no scope filter (legacy callers; background pipelines)
  //   { value: null } → recall-mode default-deny: exclude unknown:legacy
  //   { value: 'X' }  → recall-mode exact match: m.scope = 'X'
  // Private-scope (`<source>:private:*`) regex filtering remains a JS
  // post-load step in `recall()` — the regex doesn't translate cleanly to
  // SQL, and the JS helper covers all four recall consumers consistently.
  //
  // **Cross-reference:** `passesScopeFilterForRecall` in src/api.ts encodes
  // the same default-deny rule. If the deny list grows (e.g. add
  // `unknown:purged`), update BOTH this SQL clause AND that helper AND the
  // continuity inline closure. v1.7.2 will consolidate them.
  let scopeClauseAlias = '';
  let scopeClauseNoAlias = '';
  let scopeClauseTenantOnly = '';
  const scopeParams: string[] = [];
  if (scopeFilter !== undefined) {
    if (scopeFilter.mode === 'default-deny') {
      // T2: bind from RECALL_DEFAULT_DENY_SCOPES so SQL and JS share one
      // source of truth. Module-load assertion at the top of this file
      // guarantees length > 0, so NOT IN () (a SQL parse error) is impossible.
      // NULL handling: m.scope NOT IN (?, ?) returns NULL on m.scope = NULL
      // (three-valued logic). The `m.scope IS NULL OR ...` disjunct admits
      // NULL rows.
      const placeholders = RECALL_DEFAULT_DENY_SCOPES.map(() => '?').join(', ');
      scopeClauseAlias = ` AND (m.scope IS NULL OR m.scope NOT IN (${placeholders}))`;
      scopeClauseNoAlias = ` AND (scope IS NULL OR scope NOT IN (${placeholders}))`;
      scopeClauseTenantOnly = scopeClauseNoAlias;
      scopeParams.push(...RECALL_DEFAULT_DENY_SCOPES);
    } else {
      // mode === 'exact'
      scopeClauseAlias = ` AND m.scope = ?`;
      scopeClauseNoAlias = ` AND scope = ?`;
      scopeClauseTenantOnly = scopeClauseNoAlias;
      scopeParams.push(scopeFilter.value);
    }
  }

  const terms = Array.from(new Set(tokenize(query)));
  if (terms.length === 0) {
    // F3 (v1.7.0) self-review: empty-query path is the second uncapped
    // path (codex diff-pass caught the full-store fallback at the bottom;
    // this no-terms path had the same shape). Apply LIMIT so all four
    // candidate paths honour the caller's cap when set.
    const sql = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories${tenantOnlyPredicate}${archivedClauseTenantOnly}${scopeClauseTenantOnly} ORDER BY created ASC, id ASC LIMIT ?`;
    return db.prepare(sql).all(...tenantParams, ...scopeParams, limit) as MemoryRow[];
  }

  // v1.7.1 — test/diagnostic hook: `HIPPO_FORCE_LIKE_PATH=1` forces the
  // LIKE-fallback path here only. Gated at the read-call site so writes
  // (`syncFtsRow`, `deleteFtsRow`, `raw-archive.ts::archiveRaw`) keep using
  // `isFtsAvailable` honestly and never silently skip FTS index sync.
  // Lets tests exercise the LIKE branch deterministically without
  // poisoning the on-disk FTS state.
  const forceLikePath = process.env.HIPPO_FORCE_LIKE_PATH === '1';
  if (!forceLikePath && isFtsAvailable(db)) {
    try {
      const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
      // memories_fts virtual table has no tenant_id column; filter via the
      // joined memories row (cheap with idx_memories_tenant_created leading
      // on tenant_id).
      // F1 (v1.7.0): MEMORY_SEARCH_COLUMNS adds bm25_score as the trailing
      // result column. Every other column is m.<col> AS <col> so rowToEntry
      // sees the same shape it always has.
      const rows = db.prepare(`
        SELECT ${MEMORY_SEARCH_COLUMNS}
        FROM memories m
        JOIN memories_fts f ON f.id = m.id
        WHERE memories_fts MATCH ?${tenantPredicate}${archivedClauseAlias}${scopeClauseAlias}
        ORDER BY bm25(memories_fts), m.updated_at DESC
        LIMIT ?
      `).all(ftsQuery, ...tenantParams, ...scopeParams, limit) as MemoryRow[];

      if (rows.length > 0) return rows;
    } catch {
      // Fall back to LIKE matching below.
    }
  }

  const escapeLike = (term: string): string => term.replace(/[%_\\]/g, '\\$&');
  const where = terms.map(() => `(LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(tags_json) LIKE ? ESCAPE '\\')`).join(' OR ');
  const params = terms.flatMap((term) => {
    const like = `%${escapeLike(term)}%`;
    return [like, like];
  });

  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE (${where})${tenantPredicateNoAlias}${archivedClauseNoAlias}${scopeClauseNoAlias}
    ORDER BY updated_at DESC, created DESC
    LIMIT ?
  `).all(...params, ...tenantParams, ...scopeParams, limit) as MemoryRow[];

  if (rows.length > 0) return rows;

  // F3 (v1.7.0) codex P1: pre-v1.7.0 the full-store fallback ignored
  // `limit` and could return the whole tenant store. With scorerWindow
  // now reported on RecallResult, an unbounded fallback would lie about
  // candidate-pool size. Apply LIMIT here so all four paths honour the
  // caller's cap.
  const fallback = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories${tenantOnlyPredicate}${archivedClauseTenantOnly}${scopeClauseTenantOnly} ORDER BY created ASC, id ASC LIMIT ?`;
  return db.prepare(fallback).all(...tenantParams, ...scopeParams, limit) as MemoryRow[];
}

function writeMarkdownMirror(hippoRoot: string, entry: MemoryEntry): void {
  removeEntryMirrors(hippoRoot, entry.id);
  const dir = layerDir(hippoRoot, entry.layer);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${entry.id}.md`), serializeEntry(entry), 'utf8');
}

export function removeEntryMirrors(hippoRoot: string, id: string): void {
  for (const layer of [Layer.Buffer, Layer.Episodic, Layer.Semantic]) {
    const file = path.join(layerDir(hippoRoot, layer), `${id}.md`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

function bootstrapLegacyStore(db: ReturnType<typeof openHippoDb>, hippoRoot: string): boolean {
  const countRow = db.prepare(`SELECT COUNT(*) AS count FROM memories`).get() as { count?: number } | undefined;
  const memoryCount = Number(countRow?.count ?? 0);
  if (memoryCount > 0) return false;

  const legacyEntries = loadLegacyEntriesFromMarkdown(hippoRoot);
  if (legacyEntries.length === 0) return false;

  db.exec('BEGIN');
  try {
    for (const entry of legacyEntries) {
      upsertEntryRow(db, entry);
    }

    const legacyIndex = loadLegacyIndexFile(hippoRoot);
    setMeta(db, 'last_retrieval_ids', JSON.stringify(legacyIndex.last_retrieval_ids ?? []));

    const legacyStats = loadLegacyStatsFile(hippoRoot);
    setMeta(db, 'total_remembered', String(Number(legacyStats.total_remembered ?? 0)));
    setMeta(db, 'total_recalled', String(Number(legacyStats.total_recalled ?? 0)));
    setMeta(db, 'total_forgotten', String(Number(legacyStats.total_forgotten ?? 0)));

    const runs = Array.isArray(legacyStats.consolidation_runs) ? legacyStats.consolidation_runs : [];
    const insertRun = db.prepare(`INSERT INTO consolidation_runs(timestamp, decayed, merged, removed) VALUES (?, ?, ?, ?)`);
    for (const run of runs) {
      if (!run || typeof run !== 'object') continue;
      const row = run as Record<string, unknown>;
      insertRun.run(
        String(row.timestamp ?? new Date().toISOString()),
        Number(row.decayed ?? 0),
        Number(row.merged ?? 0),
        Number(row.removed ?? 0)
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function loadLegacyEntriesFromMarkdown(hippoRoot: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const layer of [Layer.Buffer, Layer.Episodic, Layer.Semantic]) {
    const dir = layerDir(hippoRoot, layer);
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const entry = deserializeEntry(raw);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function loadLegacyIndexFile(hippoRoot: string): HippoIndex {
  const indexPath = path.join(hippoRoot, 'index.json');
  if (!fs.existsSync(indexPath)) {
    return { version: 1, entries: {}, last_retrieval_ids: [] };
  }

  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as HippoIndex;
  } catch {
    return { version: 1, entries: {}, last_retrieval_ids: [] };
  }
}

function loadLegacyStatsFile(hippoRoot: string): Record<string, unknown> {
  const statsPath = path.join(hippoRoot, 'stats.json');
  if (!fs.existsSync(statsPath)) {
    return {
      total_remembered: 0,
      total_recalled: 0,
      total_forgotten: 0,
      consolidation_runs: [],
    };
  }

  try {
    return JSON.parse(fs.readFileSync(statsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {
      total_remembered: 0,
      total_recalled: 0,
      total_forgotten: 0,
      consolidation_runs: [],
    };
  }
}

function upsertEntryRow(db: ReturnType<typeof openHippoDb>, entry: MemoryEntry): void {
  db.prepare(`
    INSERT INTO memories(
      id, created, last_retrieved, retrieval_count, strength, half_life_days, layer,
      tags_json, emotional_valence, schema_fit, source, outcome_score,
      outcome_positive, outcome_negative,
      conflicts_with_json, pinned, confidence, content,
      parents_json, starred,
      trace_outcome, source_session_id,
      valid_from, superseded_by,
      extracted_from,
      dag_level, dag_parent_id,
      kind, scope, owner, artifact_ref,
      tenant_id,
      descendant_count, earliest_at, latest_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      created = excluded.created,
      last_retrieved = excluded.last_retrieved,
      retrieval_count = excluded.retrieval_count,
      strength = excluded.strength,
      half_life_days = excluded.half_life_days,
      layer = excluded.layer,
      tags_json = excluded.tags_json,
      emotional_valence = excluded.emotional_valence,
      schema_fit = excluded.schema_fit,
      source = excluded.source,
      outcome_score = excluded.outcome_score,
      outcome_positive = excluded.outcome_positive,
      outcome_negative = excluded.outcome_negative,
      conflicts_with_json = excluded.conflicts_with_json,
      pinned = excluded.pinned,
      confidence = excluded.confidence,
      content = excluded.content,
      parents_json = excluded.parents_json,
      starred = excluded.starred,
      trace_outcome = excluded.trace_outcome,
      source_session_id = excluded.source_session_id,
      valid_from = excluded.valid_from,
      superseded_by = excluded.superseded_by,
      extracted_from = excluded.extracted_from,
      dag_level = excluded.dag_level,
      dag_parent_id = excluded.dag_parent_id,
      kind = excluded.kind,
      scope = excluded.scope,
      owner = excluded.owner,
      artifact_ref = excluded.artifact_ref,
      tenant_id = excluded.tenant_id,
      descendant_count = excluded.descendant_count,
      earliest_at = excluded.earliest_at,
      latest_at = excluded.latest_at,
      updated_at = datetime('now')
  `).run(
    entry.id,
    entry.created,
    entry.last_retrieved,
    entry.retrieval_count,
    entry.strength,
    entry.half_life_days,
    entry.layer,
    JSON.stringify(entry.tags ?? []),
    entry.emotional_valence,
    entry.schema_fit,
    entry.source,
    entry.outcome_score,
    entry.outcome_positive ?? 0,
    entry.outcome_negative ?? 0,
    JSON.stringify(entry.conflicts_with ?? []),
    entry.pinned ? 1 : 0,
    entry.confidence,
    entry.content,
    JSON.stringify(entry.parents ?? []),
    entry.starred ? 1 : 0,
    entry.trace_outcome ?? null,
    entry.source_session_id ?? null,
    entry.valid_from ?? entry.created,
    entry.superseded_by ?? null,
    entry.extracted_from ?? null,
    entry.dag_level ?? 0,
    entry.dag_parent_id ?? null,
    entry.kind ?? 'distilled',
    entry.scope ?? null,
    entry.owner ?? null,
    entry.artifact_ref ?? null,
    entry.tenantId ?? 'default',
    entry.descendant_count ?? 0,
    entry.earliest_at ?? null,
    entry.latest_at ?? null,
  );

  syncFtsRow(db, entry);
}

function syncFtsRow(db: ReturnType<typeof openHippoDb>, entry: MemoryEntry): void {
  if (!isFtsAvailable(db)) return;
  try {
    db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(entry.id);
    db.prepare(`INSERT INTO memories_fts(id, content, tags) VALUES (?, ?, ?)`).run(
      entry.id,
      entry.content,
      entry.tags.join(' ')
    );
  } catch {
    // Best effort only. SQLite store is still authoritative even if FTS is unavailable.
  }
}

function deleteFtsRow(db: ReturnType<typeof openHippoDb>, id: string): void {
  if (!isFtsAvailable(db)) return;
  try {
    db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(id);
  } catch {
    // Best effort.
  }
}

function buildIndexFromDb(db: ReturnType<typeof openHippoDb>): HippoIndex {
  const rows = db.prepare(`SELECT id, created, last_retrieved, strength, layer, tags_json, pinned FROM memories ORDER BY created ASC, id ASC`).all() as Array<{
    id: string;
    created: string;
    last_retrieved: string;
    strength: number;
    layer: string;
    tags_json: string;
    pinned: number;
  }>;

  const entries: Record<string, IndexEntry> = {};
  for (const row of rows) {
    const layer = row.layer as Layer;
    entries[row.id] = {
      id: row.id,
      file: path.join(layer, `${row.id}.md`),
      layer,
      strength: Number(row.strength ?? 0),
      tags: parseJsonArray(row.tags_json),
      created: row.created,
      last_retrieved: row.last_retrieved,
      pinned: Boolean(row.pinned),
    };
  }

  return {
    version: INDEX_VERSION,
    entries,
    last_retrieval_ids: parseJsonArray(getMeta(db, 'last_retrieval_ids', '[]')),
  };
}

function buildStatsFromDb(db: ReturnType<typeof openHippoDb>): Record<string, unknown> {
  const runs = db.prepare(`SELECT timestamp, decayed, merged, removed FROM consolidation_runs ORDER BY timestamp ASC, id ASC`).all() as ConsolidationRunRow[];

  return {
    total_remembered: Number(getMeta(db, 'total_remembered', '0')),
    total_recalled: Number(getMeta(db, 'total_recalled', '0')),
    total_forgotten: Number(getMeta(db, 'total_forgotten', '0')),
    consolidation_runs: runs,
  };
}

function writeIndexMirror(hippoRoot: string, index: HippoIndex): void {
  fs.writeFileSync(path.join(hippoRoot, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
}

function writeStatsMirror(hippoRoot: string, stats: Record<string, unknown>): void {
  fs.writeFileSync(path.join(hippoRoot, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8');
}

function syncMirrorFiles(hippoRoot: string, db: ReturnType<typeof openHippoDb>): void {
  const entries = db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ORDER BY created ASC, id ASC`).all() as MemoryRow[];

  for (const entry of entries.map(rowToEntry)) {
    writeMarkdownMirror(hippoRoot, entry);
  }

  const conflicts = db.prepare(`
    SELECT id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at
    FROM memory_conflicts
    WHERE status = 'open'
    ORDER BY updated_at DESC, id DESC
  `).all() as MemoryConflictRow[];
  writeConflictMirrors(hippoRoot, conflicts.map(rowToMemoryConflict));

  writeIndexMirror(hippoRoot, buildIndexFromDb(db));
  writeStatsMirror(hippoRoot, buildStatsFromDb(db));
}

/**
 * Load the current derived index from SQLite and refresh the mirror file.
 */
export function loadIndex(hippoRoot: string): HippoIndex {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const index = buildIndexFromDb(db);
    writeIndexMirror(hippoRoot, index);
    return index;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Persist mutable index metadata. Entry rows themselves are derived from SQLite.
 */
export function saveIndex(hippoRoot: string, index: HippoIndex): void {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    setMeta(db, 'last_retrieval_ids', JSON.stringify(index.last_retrieval_ids ?? []));
    writeIndexMirror(hippoRoot, buildIndexFromDb(db));
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Write a memory entry to SQLite and refresh compatibility mirrors.
 *
 * `opts.actor` defaults to 'cli' so unauthenticated direct-CLI callers still
 * get the right audit attribution. The HTTP server (A1) and api.* layer pass
 * the resolved actor (`api_key:<key_id>` / `localhost:cli`) so audit events
 * land with one row per write, no double-emit.
 *
 * `opts.afterWrite` is invoked inside the same SAVEPOINT as the memories
 * INSERT (mirrors archiveRawMemory's shape in raw-archive.ts). On callback
 * throw, the SAVEPOINT rolls back — the memory row never lands, and the
 * filesystem mirrors / audit emit never run. Used by E1.3+ connectors to
 * stamp idempotency rows atomically with the memory write.
 */
export function writeEntry(
  hippoRoot: string,
  entry: MemoryEntry,
  opts?: {
    actor?: string;
    afterWrite?: (db: DatabaseSyncLike, memoryId: string) => void;
  },
): void {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    writeEntryDbOnly(db, entry, opts);
    writeEntryMirrors(hippoRoot, db, entry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * DB-only write path. Caller owns the open `db` handle. Runs SAVEPOINT +
 * upsert + afterWrite hook + audit row inside the SAVEPOINT scope. Caller
 * is responsible for opening `db`, optionally wrapping in a larger BEGIN/
 * COMMIT (e.g. supersede's BEGIN IMMEDIATE), closing `db`, AND calling
 * `writeEntryMirrors` after the larger tx commits — mirrors must run
 * post-commit so a rolled-back tx never leaves orphan markdown.
 *
 * Audit-order note: the audit row is emitted INSIDE the SAVEPOINT, so audit
 * commits atomically with the row INSERT. A subsequent mirror failure cannot
 * leave a recorded audit entry without its corresponding DB row. This is a
 * documented hardening over the prior writeEntry-as-monolith ordering.
 */
export function writeEntryDbOnly(
  db: DatabaseSyncLike,
  entry: MemoryEntry,
  opts?: {
    actor?: string;
    afterWrite?: (db: DatabaseSyncLike, memoryId: string) => void;
  },
): void {
  // SAVEPOINT (not BEGIN) so this nests safely inside any outer transaction
  // a caller might hold (e.g. supersede's BEGIN IMMEDIATE). SQLite refuses
  // BEGIN within a transaction; SAVEPOINT is the only way to scope rollback
  // without disturbing outers.
  db.exec('SAVEPOINT write_entry');
  try {
    upsertEntryRow(db, entry);
    if (opts?.afterWrite) {
      opts.afterWrite(db, entry.id);
    }
    audit(
      db,
      'remember',
      entry.id,
      {
        kind: entry.kind ?? 'distilled',
        scope: entry.scope ?? null,
      },
      opts?.actor ?? 'cli',
      entry.tenantId,
    );
    // v0.30 / E2 — DAG live-coupling: child write under a level-2 summary
    // marks the parent dirty for E3 sleep-cycle rebuild. Early-exit on
    // null dag_parent_id (vast majority of writes); cost is one null check
    // on the hot path.
    if (entry.dag_parent_id) {
      markSummaryDirtyInTx(db, entry.dag_parent_id, entry.tenantId, opts?.actor ?? 'cli');
    }
    db.exec('RELEASE SAVEPOINT write_entry');
  } catch (e) {
    try {
      db.exec('ROLLBACK TO SAVEPOINT write_entry');
      db.exec('RELEASE SAVEPOINT write_entry');
    } catch {
      // Ignore rollback failures — the throw below is what matters.
    }
    throw e;
  }
}

/**
 * Filesystem mirrors path. Caller passes `hippoRoot` + an open `db` handle
 * (used by `buildIndexFromDb` to derive the index from the source of truth).
 * MUST be invoked AFTER the outer transaction commits — a mirror write
 * during a tx that subsequently rolls back would leave orphan markdown.
 */
export function writeEntryMirrors(
  hippoRoot: string,
  db: DatabaseSyncLike,
  entry: MemoryEntry,
): void {
  writeMarkdownMirror(hippoRoot, entry);
  writeIndexMirror(hippoRoot, buildIndexFromDb(db));
}

/**
 * Read a memory entry by ID.
 *
 * When `tenantId` is provided, the read is scoped to that tenant (cross-tenant
 * lookups return null). When omitted, no tenant filter is applied — preserves
 * legacy single-tenant callers and the writeEntry/readEntry round-trip.
 */
export function readEntry(hippoRoot: string, id: string, tenantId?: string): MemoryEntry | null {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const row = tenantId !== undefined
      ? db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ? AND tenant_id = ?`,
        ).get(id, tenantId) as MemoryRow | undefined
      : db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ?`,
        ).get(id) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Batched lookup. Caps at 500 ids per call to keep the IN(?,?,...) clause
 * within SQLite limits. Tenant filter is enforced when `tenantId` is passed.
 * Used by DAG-aware recall (docs/plans/2026-05-05-dag-recall.md Task 1.5)
 * to fetch parent summaries for a set of overflowed leaves.
 */
export function loadEntriesByIds(
  hippoRoot: string,
  ids: readonly string[],
  tenantId?: string,
): MemoryEntry[] {
  if (ids.length === 0) return [];
  const capped = ids.slice(0, 500);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const placeholders = capped.map(() => '?').join(',');
    const rows = tenantId !== undefined
      ? db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${placeholders}) AND tenant_id = ?`,
        ).all(...capped, tenantId) as MemoryRow[]
      : db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${placeholders})`,
        ).all(...capped) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * All `kind='raw'` rows for a given session, tenant-scoped, returned
 * oldest-first. Used by `api.assemble` to walk a session's chronological
 * context. Excludes superseded rows.
 *
 * Cap semantics (v1.6.2 codex fix): when `cap` is provided, the NEWEST
 * `cap` rows are loaded — `ORDER BY created DESC LIMIT cap` server-side,
 * reversed to oldest-first client-side. Pre-v1.6.2 ordered ASC + LIMIT,
 * which silently dropped the newest rows and broke fresh-tail in assemble.
 *
 * Returns `[]` for an empty sessionId. Final order: `created ASC, id ASC`.
 */
export function loadSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId?: string,
  cap?: number,
): MemoryEntry[] {
  if (!sessionId) return [];
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const params: Array<string | number> = [];
    let sql = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' AND source_session_id = ? AND superseded_by IS NULL`;
    params.push(sessionId);
    if (tenantId !== undefined) {
      sql += ' AND tenant_id = ?';
      params.push(tenantId);
    }
    if (cap !== undefined && cap > 0) {
      sql += ' ORDER BY created DESC, id DESC LIMIT ?';
      params.push(cap);
      const rows = db.prepare(sql).all(...params) as MemoryRow[];
      return rows.reverse().map(rowToEntry);
    }
    sql += ' ORDER BY created ASC, id ASC';
    const rows = db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Pre-cap, scope-aware row count for a session. Lets `assemble` report
 * the full session size even when `rowCap` truncates the loaded window,
 * WITHOUT leaking rows the caller wouldn't have been allowed to load.
 *
 * v1.6.3 codex P1 / senior P0: an earlier draft of this helper ran an
 * unscoped COUNT, which let a no-scope caller infer the existence of
 * private rows by comparing `totalRaw` against `items.length`. This
 * version SQL-encodes the same default-deny rule `passesScopeFilterForRecall`
 * applies in TS:
 *   - explicit scope passed: exact-match
 *   - no scope: rows where scope IS NULL, or scope is NOT a `<source>:private:*`
 *     pattern AND not the `unknown:legacy` quarantine bucket.
 *
 * `tenantId` is optional for back-compat. Pass `undefined` only when
 * intentionally counting cross-tenant; `assemble()` passes `ctx.tenantId`.
 */
export function countSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId?: string,
  scope?: string,
): number {
  if (!sessionId) return 0;
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const params: Array<string> = [];
    let sql = `SELECT COUNT(*) AS c FROM memories WHERE kind = 'raw' AND source_session_id = ? AND superseded_by IS NULL`;
    params.push(sessionId);
    if (tenantId !== undefined) {
      sql += ' AND tenant_id = ?';
      params.push(tenantId);
    }
    if (scope !== undefined && scope !== '') {
      sql += ' AND scope = ?';
      params.push(scope);
    } else {
      // SQL-ify the TS default-deny: scope IS NULL OR (NOT LIKE '%:private:%'
      // AND != 'unknown:legacy'). Mirrors api.passesScopeFilterForRecall.
      sql += ` AND (scope IS NULL OR (scope NOT LIKE '%:private:%' AND scope != 'unknown:legacy'))`;
    }
    const row = db.prepare(sql).get(...params) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Last N kind='raw' memories by `created` desc. Tenant scoped. When
 * `sessionId` is supplied, also constrains to a specific session — that
 * is the correct shape for "what did I just see in THIS session."
 *
 * v1.6.2 codex review fix: pre-v1.6.2 was tenant-wide only. With multiple
 * concurrent sessions in a tenant, fresh-tail recall surfaced unrelated
 * rows from other sessions and stamped them `isFreshTail=true`. Callers
 * that want session-scoped fresh-tail now pass `sessionId`. The
 * tenant-wide form (no sessionId) still exists for "anything new across
 * the whole tenant" — pass undefined to opt in.
 *
 * Bounded count cap at 200 — beyond that the caller should filter via
 * tags/scope rather than time-windowed recall.
 *
 * Deprecation note (v1.6.5) — the **tenant-wide call shape** (omitting
 * `sessionId`) is rarely the right shape for "what did I just see in this
 * conversation". `api.recall` enforces session scoping when
 * `HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1` is set, throwing
 * `RecallContractError` instead. Tenant-wide remains the back-compat default
 * but is discouraged for new callers. Passing `sessionId` is fully supported
 * and recommended; this function is NOT deprecated as a whole.
 */
export function loadFreshRawMemories(
  hippoRoot: string,
  count: number,
  tenantId?: string,
  sessionId?: string,
): MemoryEntry[] {
  if (count <= 0) return [];
  const capped = Math.min(count, 200);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const params: Array<string | number> = [];
    let sql = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' AND superseded_by IS NULL`;
    if (tenantId !== undefined) {
      sql += ' AND tenant_id = ?';
      params.push(tenantId);
    }
    if (sessionId !== undefined && sessionId !== '') {
      sql += ' AND source_session_id = ?';
      params.push(sessionId);
    }
    sql += ' ORDER BY created DESC LIMIT ?';
    params.push(capped);
    const rows = db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Direct DAG children of a parent summary. Tenant scoped. Returns only rows
 * whose `dag_parent_id` matches `parentId`; does NOT walk recursively.
 * Used by `drillDown` (Task 3).
 */
export function loadChildrenOf(
  hippoRoot: string,
  parentId: string,
  tenantId?: string,
): MemoryEntry[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = tenantId !== undefined
      ? db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE dag_parent_id = ? AND tenant_id = ? ORDER BY created ASC, id ASC`,
        ).all(parentId, tenantId) as MemoryRow[]
      : db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE dag_parent_id = ? ORDER BY created ASC, id ASC`,
        ).all(parentId) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Delete an entry from SQLite and mirrors.
 *
 * `opts.actor` defaults to 'cli'. The api.* layer threads `ctx.actor` so HTTP
 * callers land with `api_key:<key_id>` in the audit log without a duplicate
 * emit from the api wrapper.
 */
export function deleteEntry(
  hippoRoot: string,
  id: string,
  opts?: { actor?: string },
): boolean {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db
      .prepare(`SELECT id, tenant_id, dag_parent_id FROM memories WHERE id = ?`)
      .get(id) as { id?: string; tenant_id?: string; dag_parent_id?: string | null } | undefined;
    if (!row?.id) return false;

    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    deleteFtsRow(db, id);
    removeEntryMirrors(hippoRoot, id);
    writeIndexMirror(hippoRoot, buildIndexFromDb(db));
    audit(db, 'forget', id, undefined, opts?.actor ?? 'cli', row.tenant_id);
    // v0.30 / E2 — DAG live-coupling: forget of a child under a level-2
    // summary marks parent dirty. Non-atomic with the DELETE (deleteEntry
    // has no SAVEPOINT wrapper); markSummaryDirtyInTx is idempotent so any
    // future child mutation re-marks parent if this fails. Acceptable
    // degradation, mirrors deleteEntry's existing audit best-effort posture.
    if (row.dag_parent_id) {
      markSummaryDirtyInTx(db, row.dag_parent_id, row.tenant_id ?? 'default', opts?.actor ?? 'cli');
    }
    return true;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Batch-write and batch-delete entries in a single transaction.
 * Used by consolidation to avoid N open/close cycles.
 */
export function batchWriteAndDelete(
  hippoRoot: string,
  toWrite: MemoryEntry[],
  toDeleteIds: string[],
): void {
  if (toWrite.length === 0 && toDeleteIds.length === 0) return;

  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN');
    // v0.30 / E2 — DAG live-coupling: BEFORE deletes, snapshot dag_parent_id
    // for every doomed row so we can mark parents dirty post-COMMIT. Done
    // inside the same BEGIN so the SELECT sees pre-delete state.
    // independent-review-critic R1 HIGH: consolidate.ts/sleep flushes through
    // this path every cycle; without these hooks parents NEVER get marked
    // dirty for the dominant mutation source (decay, merge, garbage-collect).
    const dirtyParents = new Set<string>();
    const tenantById = new Map<string, string>();
    if (toDeleteIds.length > 0) {
      const placeholders = toDeleteIds.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT dag_parent_id, tenant_id FROM memories WHERE id IN (${placeholders})`,
      ).all(...toDeleteIds) as Array<{ dag_parent_id: string | null; tenant_id: string | null }>;
      for (const row of rows) {
        if (row.dag_parent_id) {
          dirtyParents.add(row.dag_parent_id);
          tenantById.set(row.dag_parent_id, row.tenant_id ?? 'default');
        }
      }
    }
    for (const entry of toWrite) {
      upsertEntryRow(db, entry);
      // Hook for writes: child upserted under a level-2 summary marks parent dirty.
      if (entry.dag_parent_id) {
        dirtyParents.add(entry.dag_parent_id);
        tenantById.set(entry.dag_parent_id, entry.tenantId);
      }
    }
    for (const id of toDeleteIds) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      deleteFtsRow(db, id);
    }
    // Fire dirty-mark for every collected parent INSIDE the BEGIN, so the
    // dirty flag commits atomically with the writes + deletes.
    for (const parentId of dirtyParents) {
      markSummaryDirtyInTx(db, parentId, tenantById.get(parentId) ?? 'default', 'batch');
    }
    db.exec('COMMIT');

    // Sync mirrors once after all DB writes
    for (const entry of toWrite) {
      writeMarkdownMirror(hippoRoot, entry);
    }
    for (const id of toDeleteIds) {
      removeEntryMirrors(hippoRoot, id);
    }
    writeIndexMirror(hippoRoot, buildIndexFromDb(db));
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Load all entries from SQLite.
 *
 * When `tenantId` is provided, results are scoped to that tenant. Omitting it
 * yields all rows (legacy behavior used by consolidate/autolearn etc.). Recall
 * paths that surface results to a user MUST pass a resolved tenant.
 */
export function loadAllEntries(hippoRoot: string, tenantId?: string): MemoryEntry[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = tenantId !== undefined
      ? db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? ORDER BY created ASC, id ASC`,
        ).all(tenantId) as MemoryRow[]
      : db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ORDER BY created ASC, id ASC`,
        ).all() as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Load likely search candidates directly from SQLite.
 * Uses FTS5 when available, falls back to LIKE matching, then full-store fallback.
 *
 * When `tenantId` is provided, every SELECT (FTS join, LIKE, fallback) filters
 * by tenant_id. Cross-tenant memories never surface. Omitted = no filter.
 */
export function loadSearchEntries(
  hippoRoot: string,
  query: string,
  limit: number = DEFAULT_SEARCH_CANDIDATE_LIMIT,
  tenantId?: string,
): MemoryEntry[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    return loadSearchRows(db, query, limit, tenantId).map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * v1.7.1 — recall-mode loader. Pushes the recall-side scope predicate into
 * SQL so `unknown:legacy` cannot leak via any consumer that hasn't remembered
 * to re-filter (root-cause-over-patches: codex flagged this on v1.6.5 review).
 *
 * - `requestedScope` undefined / '': default-deny on `unknown:legacy`.
 * - `requestedScope` non-empty string: exact match on `m.scope = requestedScope`.
 *
 * Private-scope (`<source>:private:*`) regex filter remains a JS post-load
 * step in `api.recall()` — the regex doesn't translate cleanly to SQL and the
 * existing `passesScopeFilterForRecall` helper covers it consistently.
 *
 * Consumers: `api.recall` (v1.7.1+). Background pipelines (`consolidate`,
 * `embeddings`, `refine-llm`, ...) keep using `loadSearchEntries` so they
 * can see quarantined rows when needed.
 */
export function loadRecallSearchEntries(
  hippoRoot: string,
  query: string,
  limit: number = DEFAULT_SEARCH_CANDIDATE_LIMIT,
  tenantId: string,
  requestedScope?: string,
): MemoryEntry[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const scopeFilter: RecallScopeFilter =
      requestedScope && requestedScope !== ''
        ? { mode: 'exact', value: requestedScope }
        : { mode: 'default-deny' };
    return loadSearchRows(db, query, limit, tenantId, scopeFilter).map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Rebuild mirrors from SQLite, importing any legacy markdown files not already present.
 */
export function rebuildIndex(hippoRoot: string): HippoIndex {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const existingIds = new Set(
      (db.prepare(`SELECT id FROM memories`).all() as Array<{ id: string }>).map((row) => row.id)
    );
    const legacyEntries = loadLegacyEntriesFromMarkdown(hippoRoot).filter((entry) => !existingIds.has(entry.id));
    if (legacyEntries.length > 0) {
      db.exec('BEGIN');
      try {
        for (const entry of legacyEntries) {
          upsertEntryRow(db, entry);
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* ignore if no active txn */ }
        throw err;
      }
    }

    syncMirrorFiles(hippoRoot, db);
    return buildIndexFromDb(db);
  } finally {
    closeHippoDb(db);
  }
}

export function updateStats(
  hippoRoot: string,
  delta: { remembered?: number; recalled?: number; forgotten?: number }
): void {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const remembered = Number(getMeta(db, 'total_remembered', '0')) + Number(delta.remembered ?? 0);
    const recalled = Number(getMeta(db, 'total_recalled', '0')) + Number(delta.recalled ?? 0);
    const forgotten = Number(getMeta(db, 'total_forgotten', '0')) + Number(delta.forgotten ?? 0);

    setMeta(db, 'total_remembered', String(remembered));
    setMeta(db, 'total_recalled', String(recalled));
    setMeta(db, 'total_forgotten', String(forgotten));

    writeStatsMirror(hippoRoot, buildStatsFromDb(db));
  } finally {
    closeHippoDb(db);
  }
}

export function loadStats(hippoRoot: string): Record<string, unknown> {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const stats = buildStatsFromDb(db);
    writeStatsMirror(hippoRoot, stats);
    return stats;
  } finally {
    closeHippoDb(db);
  }
}

export function appendConsolidationRun(
  hippoRoot: string,
  run: { timestamp: string; decayed: number; merged: number; removed: number }
): void {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(`INSERT INTO consolidation_runs(timestamp, decayed, merged, removed) VALUES (?, ?, ?, ?)`).run(
      run.timestamp,
      run.decayed,
      run.merged,
      run.removed
    );
    pruneConsolidationRuns(db, 50);
    writeStatsMirror(hippoRoot, buildStatsFromDb(db));
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Session decay context: provides the data needed for session-based and adaptive decay.
 */
export interface SessionDecayContext {
  /** Total number of sleep (consolidation) cycles completed. */
  sleepCount: number;
  /** Average interval between recent sleep cycles, in days. 0 if < 2 cycles. */
  avgSessionIntervalDays: number;
}

/**
 * Load the session decay context from the store.
 * Uses consolidation_runs timestamps to compute session intervals.
 */
export function loadSessionDecayContext(hippoRoot: string): SessionDecayContext {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    // Get recent consolidation timestamps (last 20)
    const rows = db.prepare(
      `SELECT timestamp FROM consolidation_runs ORDER BY timestamp DESC, id DESC LIMIT 20`
    ).all() as Array<{ timestamp: string }>;

    const sleepCount = Number(getMeta(db, 'sleep_count', '0')) || rows.length;

    if (rows.length < 2) {
      return { sleepCount, avgSessionIntervalDays: 0 };
    }

    // Compute average interval between consecutive sessions
    const timestamps = rows.map((r) => new Date(r.timestamp).getTime()).reverse();
    let totalInterval = 0;
    for (let i = 1; i < timestamps.length; i++) {
      totalInterval += timestamps[i] - timestamps[i - 1];
    }
    const avgMs = totalInterval / (timestamps.length - 1);
    const avgDays = avgMs / (1000 * 60 * 60 * 24);

    return { sleepCount, avgSessionIntervalDays: Math.max(0, avgDays) };
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Increment the sleep counter. Called after each consolidation run.
 */
export function incrementSleepCount(hippoRoot: string): void {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const current = Number(getMeta(db, 'sleep_count', '0')) || 0;
    setMeta(db, 'sleep_count', String(current + 1));
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Defensive runtime guard for tenant id arguments.
 *
 * The continuity helpers (saveActiveTaskSnapshot, listSessionEvents, etc.)
 * gained a required `tenantId` parameter in v0.41 / schema v22 to close a
 * cross-tenant data leak. TypeScript catches misbinding at compile time, but
 * JavaScript callers from older versions can silently pass a `sessionId`
 * where `tenantId` is now expected, e.g.
 *   loadLatestHandoff(root, 'sess-abc')   // WRONG: 'sess-abc' becomes the tenant
 * which would silently filter to a non-existent tenant and return null with
 * no error. This guard rejects the most common shape of that mistake (any
 * value beginning with the conventional `sess-` / `sess_` session prefix).
 *
 * False-positive cost: a tenant literally named `sess-...` will be rejected.
 * Acceptable tradeoff for catching the silent-leak class.
 */
function assertTenantId(fnName: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fnName}: tenantId is required (got ${typeof value})`);
  }
  if (/^sess[-_]/i.test(value)) {
    throw new Error(
      `${fnName}: tenantId looks like a session id ('${value}'). ` +
      `In v0.41+ these helpers take (hippoRoot, tenantId, ...). ` +
      `Pass the tenant id (e.g. 'default') and the session id separately.`,
    );
  }
}

export function saveActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  snapshot: {
    task: string;
    summary: string;
    next_step: string;
    source?: string;
    session_id?: string | null;
    scope?: string | null;
  }
): TaskSnapshot {
  assertTenantId('saveActiveTaskSnapshot', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  const now = new Date().toISOString();

  try {
    db.exec('BEGIN');
    db.prepare(`UPDATE task_snapshots SET status = 'superseded', updated_at = ? WHERE status = 'active' AND tenant_id = ?`).run(now, tenantId);

    const result = db.prepare(`
      INSERT INTO task_snapshots(task, summary, next_step, status, source, session_id, scope, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.task,
      snapshot.summary,
      snapshot.next_step,
      snapshot.source ?? 'cli',
      snapshot.session_id ?? null,
      snapshot.scope ?? null,
      tenantId,
      now,
      now,
    );

    db.exec('COMMIT');

    const id = Number(result.lastInsertRowid ?? 0);
    const row = db.prepare(`
      SELECT id, task, summary, next_step, status, source, session_id, scope, created_at, updated_at
      FROM task_snapshots
      WHERE id = ?
    `).get(id) as TaskSnapshotRow | undefined;

    if (!row) {
      throw new Error('Failed to reload saved active task snapshot');
    }

    const loaded = rowToTaskSnapshot(row);
    writeActiveTaskMirror(hippoRoot, tenantId, loaded);
    return loaded;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore nested rollback failures.
    }
    throw error;
  } finally {
    closeHippoDb(db);
  }
}

export function loadActiveTaskSnapshot(hippoRoot: string, tenantId: string): TaskSnapshot | null {
  assertTenantId('loadActiveTaskSnapshot', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`
      SELECT id, task, summary, next_step, status, source, session_id, scope, created_at, updated_at
      FROM task_snapshots
      WHERE status = 'active' AND tenant_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(tenantId) as TaskSnapshotRow | undefined;

    if (!row) {
      removeActiveTaskMirror(hippoRoot, tenantId);
      return null;
    }

    const loaded = rowToTaskSnapshot(row);
    writeActiveTaskMirror(hippoRoot, tenantId, loaded);
    return loaded;
  } finally {
    closeHippoDb(db);
  }
}

export function clearActiveTaskSnapshot(hippoRoot: string, tenantId: string, clearedStatus: string = 'cleared'): boolean {
  assertTenantId('clearActiveTaskSnapshot', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  const now = new Date().toISOString();

  try {
    const active = db.prepare(`SELECT id FROM task_snapshots WHERE status = 'active' AND tenant_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`).get(tenantId) as { id?: number } | undefined;
    if (!active?.id) {
      removeActiveTaskMirror(hippoRoot, tenantId);
      return false;
    }

    db.prepare(`UPDATE task_snapshots SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`).run(clearedStatus, now, active.id, tenantId);
    removeActiveTaskMirror(hippoRoot, tenantId);
    return true;
  } finally {
    closeHippoDb(db);
  }
}

export function appendSessionEvent(
  hippoRoot: string,
  tenantId: string,
  event: {
    session_id: string;
    event_type: string;
    content: string;
    task?: string | null;
    source?: string;
    scope?: string | null;
    metadata?: Record<string, unknown>;
  }
): SessionEvent {
  assertTenantId('appendSessionEvent', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  const now = new Date().toISOString();

  // v1.2: scope is wired through. Default-deny in api.recall + cmdRecall
  // continuity reads applies to slack:private:* and 'unknown:legacy' rows.
  try {
    const result = db.prepare(`
      INSERT INTO session_events(session_id, task, event_type, content, source, scope, metadata_json, tenant_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.session_id,
      event.task ?? null,
      event.event_type,
      event.content,
      event.source ?? 'cli',
      event.scope ?? null,
      JSON.stringify(event.metadata ?? {}),
      tenantId,
      now,
    );

    const id = Number(result.lastInsertRowid ?? 0);
    const row = db.prepare(`
      SELECT id, session_id, task, event_type, content, source, scope, metadata_json, created_at
      FROM session_events
      WHERE id = ?
    `).get(id) as SessionEventRow | undefined;

    if (!row) {
      throw new Error('Failed to reload saved session event');
    }

    const loaded = rowToSessionEvent(row);
    const recentRows = db.prepare(`
      SELECT id, session_id, task, event_type, content, source, scope, metadata_json, created_at
      FROM session_events
      WHERE session_id = ? AND tenant_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(loaded.session_id, tenantId, 20) as SessionEventRow[];
    const recent = recentRows.map(rowToSessionEvent).reverse();
    writeRecentSessionMirror(hippoRoot, tenantId, recent);
    return loaded;
  } finally {
    closeHippoDb(db);
  }
}

export function listSessionEvents(
  hippoRoot: string,
  tenantId: string,
  options: { session_id?: string; task?: string; limit?: number } = {}
): SessionEvent[] {
  assertTenantId('listSessionEvents', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const clauses: string[] = ['tenant_id = ?'];
    const params: Array<string | number> = [tenantId];

    if (options.session_id) {
      clauses.push('session_id = ?');
      params.push(options.session_id);
    }
    if (options.task) {
      clauses.push('task = ?');
      params.push(options.task);
    }

    const limit = Math.max(1, Math.trunc(options.limit ?? 8));
    params.push(limit);

    const where = `WHERE ${clauses.join(' AND ')}`;
    const rows = db.prepare(`
      SELECT id, session_id, task, event_type, content, source, scope, metadata_json, created_at
      FROM session_events
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params) as SessionEventRow[];

    return rows.map(rowToSessionEvent).reverse();
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Return session_ids with a `session_complete` event newer than `sinceMs`.
 * Used by the sleep auto-promotion pass to bound scanning to a fixed window.
 */
export function findPromotableSessions(
  hippoRoot: string,
  tenantId: string,
  sinceMs: number,
): Array<{ session_id: string }> {
  assertTenantId('findPromotableSessions', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT DISTINCT session_id FROM session_events
      WHERE event_type = 'session_complete' AND created_at >= ? AND tenant_id = ?
    `).all(new Date(sinceMs).toISOString(), tenantId) as { session_id: string }[];
    return rows;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Idempotency guard — true if a trace-layer memory with this source_session_id
 * already exists.
 */
export function traceExistsForSession(hippoRoot: string, tenantId: string, session_id: string): boolean {
  assertTenantId('traceExistsForSession', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`
      SELECT 1 FROM memories
      WHERE source_session_id = ? AND layer = 'trace' AND tenant_id = ?
      LIMIT 1
    `).get(session_id, tenantId);
    return !!row;
  } finally {
    closeHippoDb(db);
  }
}

export function listMemoryConflicts(
  hippoRoot: string,
  status: string = 'open',
  tenantId?: string,
): MemoryConflict[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    // v0.28 — '*' is a sentinel meaning "no status filter, return all rows".
    // Pre-v0.28 callers (cli/mcp/dashboard) always passed 'open' or default,
    // so this sentinel is purely additive. The 4 SQL branches below cover
    // {tenanted | unscoped} × {all-statuses | specific-status}.
    const allStatuses = status === '*';
    let rows: MemoryConflictRow[];
    if (tenantId !== undefined) {
      // Tenanted query — JOIN to memories on both conflict members and require
      // each in-tenant, so neither a normal cross-tenant pair nor a stale
      // pre-fix row surfaces (consistent with resolveConflict).
      rows = allStatuses
        ? db.prepare(`
            SELECT mc.id, mc.memory_a_id, mc.memory_b_id, mc.reason, mc.score,
                   mc.status, mc.detected_at, mc.updated_at
            FROM memory_conflicts mc
            JOIN memories ma ON ma.id = mc.memory_a_id
            JOIN memories mb ON mb.id = mc.memory_b_id
            WHERE ma.tenant_id = ? AND mb.tenant_id = ?
            ORDER BY mc.updated_at DESC, mc.id DESC
          `).all(tenantId, tenantId) as MemoryConflictRow[]
        : db.prepare(`
            SELECT mc.id, mc.memory_a_id, mc.memory_b_id, mc.reason, mc.score,
                   mc.status, mc.detected_at, mc.updated_at
            FROM memory_conflicts mc
            JOIN memories ma ON ma.id = mc.memory_a_id
            JOIN memories mb ON mb.id = mc.memory_b_id
            WHERE mc.status = ? AND ma.tenant_id = ? AND mb.tenant_id = ?
            ORDER BY mc.updated_at DESC, mc.id DESC
          `).all(status, tenantId, tenantId) as MemoryConflictRow[];
    } else {
      // Unscoped query — legacy direct-mode (CLI, tests, consolidate).
      rows = allStatuses
        ? db.prepare(`
            SELECT id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at
            FROM memory_conflicts
            ORDER BY updated_at DESC, id DESC
          `).all() as MemoryConflictRow[]
        : db.prepare(`
            SELECT id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at
            FROM memory_conflicts
            WHERE status = ?
            ORDER BY updated_at DESC, id DESC
          `).all(status) as MemoryConflictRow[];
    }
    return rows.map(rowToMemoryConflict);
  } finally {
    closeHippoDb(db);
  }
}

export function replaceDetectedConflicts(
  hippoRoot: string,
  detected: Array<{ memory_a_id: string; memory_b_id: string; reason: string; score: number }>,
  detectedAt: string = new Date().toISOString()
): void {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);

  try {
    db.exec('BEGIN');

    // Tenant guard (E2): a conflict is meaningful only within one tenant.
    // Build id -> tenant_id once and skip cross-tenant pairs both when
    // inserting rows and when rebuilding conflicts_with_json, so a stale
    // cross-tenant row can neither persist nor leak a foreign id.
    const tenantById = new Map<string, string>();
    for (const r of db.prepare(`SELECT id, tenant_id FROM memories`).all() as Array<{ id: string; tenant_id: string }>) {
      tenantById.set(r.id, r.tenant_id);
    }
    const sameTenant = (a: string, b: string): boolean => {
      const ta = tenantById.get(a);
      const tb = tenantById.get(b);
      return ta !== undefined && tb !== undefined && ta === tb;
    };

    const canonicalDetected = detected.map((conflict) => ({
      ...canonicalConflictPair(conflict.memory_a_id, conflict.memory_b_id),
      reason: conflict.reason,
      score: conflict.score,
    }));

    const detectedKeys = new Set(canonicalDetected.map((conflict) => `${conflict.memory_a_id}::${conflict.memory_b_id}`));

    const openRows = db.prepare(`
      SELECT id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at
      FROM memory_conflicts
      WHERE status = 'open'
    `).all() as MemoryConflictRow[];

    for (const row of openRows) {
      const key = `${row.memory_a_id}::${row.memory_b_id}`;
      const stale = !detectedKeys.has(key);
      // v1.11.0 residue: auto-resolve any open cross-tenant row. The insert
      // loop below (line 2089) and the refMap rebuild (line 2117) skip
      // cross-tenant pairs, but the resolve-stale loop previously left
      // re-detected cross-tenant rows lingering status='open'. The
      // sameTenant() helper is already built one block up; no extra query.
      const crossTenant = !sameTenant(row.memory_a_id, row.memory_b_id);
      if (stale || crossTenant) {
        db.prepare(`UPDATE memory_conflicts SET status = 'resolved', updated_at = ? WHERE id = ?`).run(detectedAt, row.id);
      }
    }

    for (const conflict of canonicalDetected) {
      // Skip cross-tenant pairs — never persist a conflict spanning tenants.
      if (!sameTenant(conflict.memory_a_id, conflict.memory_b_id)) continue;
      db.prepare(`
        INSERT INTO memory_conflicts(memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?)
        ON CONFLICT(memory_a_id, memory_b_id) DO UPDATE SET
          reason = excluded.reason,
          score = excluded.score,
          status = 'open',
          updated_at = excluded.updated_at
      `).run(
        conflict.memory_a_id,
        conflict.memory_b_id,
        conflict.reason,
        conflict.score,
        detectedAt,
        detectedAt,
      );
    }

    const openConflicts = db.prepare(`
      SELECT memory_a_id, memory_b_id
      FROM memory_conflicts
      WHERE status = 'open'
    `).all() as Array<{ memory_a_id: string; memory_b_id: string }>;

    const refMap = new Map<string, Set<string>>();
    for (const row of openConflicts) {
      // Skip cross-tenant pairs so a stale row never seeds a foreign id
      // into conflicts_with_json.
      if (!sameTenant(row.memory_a_id, row.memory_b_id)) continue;
      if (!refMap.has(row.memory_a_id)) refMap.set(row.memory_a_id, new Set());
      if (!refMap.has(row.memory_b_id)) refMap.set(row.memory_b_id, new Set());
      refMap.get(row.memory_a_id)!.add(row.memory_b_id);
      refMap.get(row.memory_b_id)!.add(row.memory_a_id);
    }

    const memoryRows = db.prepare(`SELECT id FROM memories`).all() as Array<{ id: string }>;
    for (const memory of memoryRows) {
      const refs = Array.from(refMap.get(memory.id) ?? []).sort();
      db.prepare(`UPDATE memories SET conflicts_with_json = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(refs), memory.id);
    }

    db.exec('COMMIT');
    syncMirrorFiles(hippoRoot, db);
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore nested rollback failures.
    }
    throw error;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Resolve a conflict by keeping one memory and weakening the other.
 * Sets conflict status to 'resolved' and halves the loser's half-life.
 * If --forget is used, the loser is deleted entirely.
 *
 * Returns the resolved conflict, or null if not found.
 */
export function resolveConflict(
  hippoRoot: string,
  conflictId: number,
  keepId: string,
  forgetLoser: boolean = false,
  tenantId?: string,
): { conflict: MemoryConflict; loserId: string } | null {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);

  // When tenantId is set, the conflict lookup requires BOTH members in-tenant
  // and every memories mutation carries AND tenant_id = ?. A cross-tenant probe
  // then returns null, indistinguishable from a bad id. Omitted tenantId =
  // legacy unscoped behaviour (CLI direct mode, tests, consolidate.ts).
  const memScope = tenantId !== undefined ? ' AND tenant_id = ?' : '';
  const memArgs: string[] = tenantId !== undefined ? [tenantId] : [];

  try {
    const row = (tenantId !== undefined
      ? db.prepare(`
          SELECT mc.id, mc.memory_a_id, mc.memory_b_id, mc.reason, mc.score,
                 mc.status, mc.detected_at, mc.updated_at
          FROM memory_conflicts mc
          JOIN memories ma ON ma.id = mc.memory_a_id
          JOIN memories mb ON mb.id = mc.memory_b_id
          WHERE mc.id = ? AND ma.tenant_id = ? AND mb.tenant_id = ?
        `).get(conflictId, tenantId, tenantId)
      : db.prepare(`
          SELECT id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at
          FROM memory_conflicts WHERE id = ?
        `).get(conflictId)) as MemoryConflictRow | undefined;

    if (!row) return null;

    const conflict = rowToMemoryConflict(row);
    if (conflict.status !== 'open') return null;

    const loserId = keepId === conflict.memory_a_id
      ? conflict.memory_b_id
      : keepId === conflict.memory_b_id
        ? conflict.memory_a_id
        : null;

    if (!loserId) return null;

    db.exec('BEGIN');

    // Mark conflict as resolved
    db.prepare(`UPDATE memory_conflicts SET status = 'resolved', updated_at = datetime('now') WHERE id = ?`)
      .run(conflictId);

    if (forgetLoser) {
      // Delete the losing memory
      db.prepare(`DELETE FROM memories WHERE id = ?${memScope}`).run(loserId, ...memArgs);
    } else {
      // Halve the loser's half-life (weakens it over time)
      db.prepare(`UPDATE memories SET half_life_days = MAX(1, half_life_days / 2), updated_at = datetime('now') WHERE id = ?${memScope}`)
        .run(loserId, ...memArgs);
    }

    // Clean up conflicts_with references
    const keepRow = db.prepare(`SELECT conflicts_with_json FROM memories WHERE id = ?${memScope}`).get(keepId, ...memArgs) as { conflicts_with_json: string } | undefined;
    if (keepRow) {
      const refs: string[] = JSON.parse(keepRow.conflicts_with_json || '[]');
      const cleaned = refs.filter((r: string) => r !== loserId);
      db.prepare(`UPDATE memories SET conflicts_with_json = ?, updated_at = datetime('now') WHERE id = ?${memScope}`)
        .run(JSON.stringify(cleaned), keepId, ...memArgs);
    }

    if (!forgetLoser) {
      const loserRow = db.prepare(`SELECT conflicts_with_json FROM memories WHERE id = ?${memScope}`).get(loserId, ...memArgs) as { conflicts_with_json: string } | undefined;
      if (loserRow) {
        const refs: string[] = JSON.parse(loserRow.conflicts_with_json || '[]');
        const cleaned = refs.filter((r: string) => r !== keepId);
        db.prepare(`UPDATE memories SET conflicts_with_json = ?, updated_at = datetime('now') WHERE id = ?${memScope}`)
          .run(JSON.stringify(cleaned), loserId, ...memArgs);
      }
    }

    db.exec('COMMIT');
    syncMirrorFiles(hippoRoot, db);

    return { conflict: { ...conflict, status: 'resolved' }, loserId };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Save a session handoff record. Returns the persisted handoff.
 */
export function saveSessionHandoff(
  hippoRoot: string,
  tenantId: string,
  handoff: Omit<SessionHandoff, 'updatedAt'>,
): SessionHandoff {
  assertTenantId('saveSessionHandoff', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  const now = new Date().toISOString();

  // v1.2: scope is wired through. Read-side default-deny in api.recall +
  // cmdRecall continuity excludes slack:private:* and 'unknown:legacy'.
  try {
    const result = db.prepare(`
      INSERT INTO session_handoffs(session_id, repo_root, task_id, summary, next_action, artifacts_json, scope, tenant_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoff.sessionId,
      handoff.repoRoot ?? null,
      handoff.taskId ?? null,
      handoff.summary,
      handoff.nextAction ?? null,
      JSON.stringify(handoff.artifacts ?? []),
      handoff.scope ?? null,
      tenantId,
      now,
    );

    const id = Number(result.lastInsertRowid ?? 0);
    const row = db.prepare(`
      SELECT id, session_id, repo_root, task_id, summary, next_action, artifacts_json, scope, created_at
      FROM session_handoffs
      WHERE id = ?
    `).get(id) as SessionHandoffRow | undefined;

    if (!row) {
      throw new Error('Failed to reload saved session handoff');
    }

    return rowToSessionHandoff(row);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Load the most recent handoff, optionally filtered by session ID.
 */
export function loadLatestHandoff(hippoRoot: string, tenantId: string, sessionId?: string): SessionHandoff | null {
  assertTenantId('loadLatestHandoff', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);

  try {
    let row: SessionHandoffRow | undefined;
    if (sessionId) {
      row = db.prepare(`
        SELECT id, session_id, repo_root, task_id, summary, next_action, artifacts_json, scope, created_at
        FROM session_handoffs
        WHERE session_id = ? AND tenant_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(sessionId, tenantId) as SessionHandoffRow | undefined;
    } else {
      row = db.prepare(`
        SELECT id, session_id, repo_root, task_id, summary, next_action, artifacts_json, scope, created_at
        FROM session_handoffs
        WHERE tenant_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(tenantId) as SessionHandoffRow | undefined;
    }

    return row ? rowToSessionHandoff(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Load a specific handoff by its row ID.
 */
export function loadHandoffById(hippoRoot: string, tenantId: string, id: number): SessionHandoff | null {
  assertTenantId('loadHandoffById', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);

  try {
    const row = db.prepare(`
      SELECT id, session_id, repo_root, task_id, summary, next_action, artifacts_json, scope, created_at
      FROM session_handoffs
      WHERE id = ? AND tenant_id = ?
    `).get(id, tenantId) as SessionHandoffRow | undefined;

    return row ? rowToSessionHandoff(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// v0.30 / E1 of DAG live-coupling — dirty-flag helpers for the existing
// DAG layer's level-2 summaries.
//
// Used by E2 (child-write propagation in invalidation.ts / writeEntry /
// forgetMemory / archiveRawMemory) to mark a summary dirty when one of its
// children changes, and by E3's sleep-cycle rebuildDirtySummaries phase to
// enumerate candidates without scanning every memory row.
// ---------------------------------------------------------------------------

/**
 * Load summaries flagged dirty for the given tenant. Sorted by latest_at
 * DESC (NULLS LAST) so E3's rebuild cap (HIPPO_DAG_REBUILD_CAP, default 20)
 * takes the most-recently-changed summaries first.
 *
 * Returns full MemoryEntry shape via MEMORY_SELECT_COLUMNS + rowToEntry
 * (v28 fields are part of the standard read path).
 */
export function loadDirtySummaries(
  hippoRoot: string,
  tenantId: string,
): MemoryEntry[] {
  assertTenantId('loadDirtySummaries', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
       WHERE summary_dirty = 1
         AND tenant_id = ?
         AND kind != 'archived'
       ORDER BY latest_at DESC NULLS LAST, id ASC
    `).all(tenantId) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * v0.30 / E2 — in-transaction variant of markSummaryDirty. Takes an open
 * db (caller is responsible for any SAVEPOINT/BEGIN). Used by E2's hook
 * sites: writeEntryDbOnly, api.supersede CAS, deleteEntry, archiveRawMemory,
 * batchWriteAndDelete. Each child mutation's dirty-mark is atomic with the
 * mutation itself (where the mutation IS in a SAVEPOINT/BEGIN — deleteEntry
 * is the exception, acceptably non-atomic by design).
 *
 * EXPORTED (required for cross-module use by api.ts + raw-archive.ts).
 * Risk of misuse (caller without open tx) is mitigated by the InTx
 * suffix + the DatabaseSyncLike typed param. Public surface for end users
 * stays at the markSummaryDirty (own-connection) variant.
 *
 * Same idempotency contract: 0->1 transition only, audit row only on
 * transition, no-op on non-summary / archived / unknown id / cross-tenant.
 */
export function markSummaryDirtyInTx(
  db: DatabaseSyncLike,
  summaryId: string,
  tenantId: string,
  actor: string,
): void {
  const result = db.prepare(`
    UPDATE memories
       SET summary_dirty = 1
     WHERE id = ?
       AND tenant_id = ?
       AND dag_level = 2
       AND summary_dirty = 0
       AND kind != 'archived'
  `).run(summaryId, tenantId);
  if ((result.changes ?? 0) > 0) {
    audit(db, 'summary_marked_dirty', summaryId, { dag_level: 2, source: 'E2' }, actor, tenantId);
  }
}

/**
 * Mark a summary as dirty. Idempotent (re-marking dirty is a no-op + no
 * second audit row). Tenant-scoped to prevent cross-tenant writes via
 * parent-lookup. Called by E2 from invalidation.ts / writeEntry /
 * forgetMemory / archiveRawMemory whenever a child is invalidated,
 * superseded, forgotten, or archived.
 *
 * Quietly no-ops if the target row doesn't exist or isn't a level-2
 * summary (E5 will widen the dag_level guard to IN (2, 3) when level-3
 * build path lands). Emits a 'summary_marked_dirty' audit row on actual
 * state transitions (0 -> 1) via the audit() helper, which try/catches
 * for missing audit_log (the v27 self-heal scenario).
 */
export function markSummaryDirty(
  hippoRoot: string,
  summaryId: string,
  tenantId: string,
  actor: string = 'cli',
): void {
  assertTenantId('markSummaryDirty', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const result = db.prepare(`
      UPDATE memories
         SET summary_dirty = 1
       WHERE id = ?
         AND tenant_id = ?
         AND dag_level = 2
         AND summary_dirty = 0
         AND kind != 'archived'
    `).run(summaryId, tenantId);
    if ((result.changes ?? 0) > 0) {
      // audit() wraps appendAuditEvent in try/catch — defends against the
      // v16-partial-state where audit_log is missing (fixed by v27 heal).
      // metadata.source=E1 leaves a breadcrumb so E2-E5 debugging can
      // distinguish dirty-marks across the arc's wiring layers.
      audit(db, 'summary_marked_dirty', summaryId, { dag_level: 2, source: 'E1' }, actor, tenantId);
    }
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// v0.30 / E3 of DAG live-coupling — sleep-cycle rebuild surface.
//
// loadAllDirtySummaries / loadChildrenOfSummary / applyRebuildResult /
// clearSummaryDirtyAfterBuild live HERE (not in dag.ts) because they need
// module-private MEMORY_SELECT_COLUMNS, MemoryRow, rowToEntry, audit,
// syncFtsRow, assertTenantId. dag.ts owns only the thin orchestrator
// rebuildDirtySummaries() that calls into these.
// ---------------------------------------------------------------------------

/**
 * v0.30 / E3 — host-wide variant of loadDirtySummaries. Iterates all tenants
 * in one query so consolidate.ts (host-wide per L106-109) does not need a
 * per-tenant loop. Each returned MemoryEntry carries its own tenantId (via
 * rowToEntry), so per-summary children + rebuild UPDATE stay tenant-scoped.
 *
 * Sort: latest_at DESC NULLS LAST, id ASC — same as per-tenant variant so
 * HIPPO_DAG_REBUILD_CAP takes most-recently-changed summaries first.
 */
export function loadAllDirtySummaries(hippoRoot: string): MemoryEntry[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
       WHERE summary_dirty = 1
         AND kind != 'archived'
       ORDER BY latest_at DESC NULLS LAST, id ASC
    `).all() as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * v0.30 / E3 — load live children of a DAG summary. Used by
 * rebuildDirtySummaries to regenerate content from the CURRENT child set
 * (not the children at create-time). Skips archived. Tenant-scoped
 * (defence in depth — dag_parent_id is unique-ish but tenant guard is
 * cheap). created column is TEXT NOT NULL since db.ts schema v1.
 */
export function loadChildrenOfSummary(
  hippoRoot: string,
  summaryId: string,
  tenantId: string,
): MemoryEntry[] {
  assertTenantId('loadChildrenOfSummary', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
       WHERE dag_parent_id = ?
         AND tenant_id = ?
         AND kind != 'archived'
       ORDER BY created ASC
    `).all(summaryId, tenantId) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * v0.30 / E3 — patch applied by applyRebuildResult. Two-branch shape
 * (bumpRebuildCount false for zero-child case, true for normal rebuild).
 */
export interface RebuildPatch {
  content: string;            // new content for normal rebuild; summary.content for zero-child
  descendant_count: number;
  earliest_at: string | null;
  latest_at: string | null;
  bumpRebuildCount: boolean;
  zeroChildren: boolean;
  actor: string;
}

/**
 * v0.30 / E3 — apply a rebuild result to a dirty summary. Atomic: one
 * prepared UPDATE statement plus syncFtsRow inside one SAVEPOINT.
 * WHERE includes `AND summary_dirty = 1` so concurrent sleep's race-loser
 * becomes a no-op (no rebuild_count bump, no audit row).
 *
 * Returns true on actual rebuild (changes > 0), false on race-loss /
 * unknown id / archived / wrong dag_level.
 */
export function applyRebuildResult(
  hippoRoot: string,
  summary: MemoryEntry,
  patch: RebuildPatch,
): boolean {
  assertTenantId('applyRebuildResult', summary.tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('SAVEPOINT rebuild_summary');
    try {
      const nowIso = new Date().toISOString();
      // ONE prepared UPDATE per branch. Test #8 inspects the SQL string.
      const sql = patch.bumpRebuildCount
        ? `UPDATE memories
              SET content = ?,
                  descendant_count = ?,
                  earliest_at = ?,
                  latest_at = ?,
                  last_rebuilt_at = ?,
                  rebuild_count = COALESCE(rebuild_count, 0) + 1,
                  summary_dirty = 0
            WHERE id = ?
              AND tenant_id = ?
              AND dag_level = 2
              AND summary_dirty = 1
              AND kind != 'archived'`
        : `UPDATE memories
              SET descendant_count = ?,
                  earliest_at = ?,
                  latest_at = ?,
                  summary_dirty = 0
            WHERE id = ?
              AND tenant_id = ?
              AND dag_level = 2
              AND summary_dirty = 1
              AND kind != 'archived'`;

      const result = patch.bumpRebuildCount
        ? db.prepare(sql).run(
            patch.content,
            patch.descendant_count,
            patch.earliest_at,
            patch.latest_at,
            nowIso,
            summary.id,
            summary.tenantId,
          )
        : db.prepare(sql).run(
            patch.descendant_count,
            patch.earliest_at,
            patch.latest_at,
            summary.id,
            summary.tenantId,
          );

      const changed = (result.changes ?? 0) > 0;

      if (changed) {
        // FTS sync — bare UPDATE on memories does NOT update memories_fts.
        // R1 HIGH must-fix from plan-eng-r1. Construct the patched entry in
        // memory and reuse the existing syncFtsRow helper (delete-then-insert).
        // earliest_at/latest_at preserve null semantics (R2 must-fix).
        const patchedEntry: MemoryEntry = {
          ...summary,
          content: patch.content,
          descendant_count: patch.descendant_count,
          earliest_at: patch.earliest_at,
          latest_at: patch.latest_at,
          summary_dirty: 0,
          last_rebuilt_at: patch.bumpRebuildCount ? nowIso : summary.last_rebuilt_at,
          rebuild_count: patch.bumpRebuildCount
            ? (summary.rebuild_count ?? 0) + 1
            : summary.rebuild_count,
        };
        syncFtsRow(db, patchedEntry);

        audit(
          db,
          'summary_rebuilt',
          summary.id,
          {
            dag_level: 2,
            source: 'E3-rebuild',
            zero_children: patch.zeroChildren,
            descendant_count: patch.descendant_count,
          },
          patch.actor,
          summary.tenantId,
        );
      }

      db.exec('RELEASE SAVEPOINT rebuild_summary');
      return changed;
    } catch (e) {
      try {
        db.exec('ROLLBACK TO SAVEPOINT rebuild_summary');
        db.exec('RELEASE SAVEPOINT rebuild_summary');
      } catch {
        // Ignore rollback failures — throw below is what matters.
      }
      throw e;
    }
  } finally {
    closeHippoDb(db);
  }
}

/**
 * v0.30 / E3 — clear summary_dirty on a freshly-built summary. Called by
 * buildDag immediately after the child-link loop finishes. Without this,
 * each member's writeEntry call fires markSummaryDirtyInTx on the just-
 * created parent (E2 hook at store.ts:1214), and the same sleep cycle's
 * E3 rebuild phase would re-rebuild every new summary (2x LLM cost).
 *
 * Idempotent: no-op + no audit if summary isn't dirty. Audit
 * source='buildDag-clean' distinguishes from E3-rebuild source.
 */
export function clearSummaryDirtyAfterBuild(
  hippoRoot: string,
  summaryId: string,
  tenantId: string,
  actor: string = 'cli',
): void {
  assertTenantId('clearSummaryDirtyAfterBuild', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const result = db.prepare(`
      UPDATE memories
         SET summary_dirty = 0
       WHERE id = ?
         AND tenant_id = ?
         AND dag_level = 2
         AND summary_dirty = 1
         AND kind != 'archived'
    `).run(summaryId, tenantId);
    if ((result.changes ?? 0) > 0) {
      audit(db, 'summary_marked_clean', summaryId, { dag_level: 2, source: 'buildDag-clean' }, actor, tenantId);
    }
  } finally {
    closeHippoDb(db);
  }
}

export { getHippoDbPath };
