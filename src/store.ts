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
): void {
  try {
    appendAuditEvent(db, {
      tenantId: resolveTenantId({}),
      actor: 'cli',
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
  metadata: Record<string, unknown>;
  created_at: string;
}

const INDEX_VERSION = 3;
const MEMORY_SELECT_COLUMNS = `id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, outcome_score, outcome_positive, outcome_negative, conflicts_with_json, pinned, confidence, content, parents_json, starred, trace_outcome, source_session_id, valid_from, superseded_by, extracted_from, dag_level, dag_parent_id, kind, scope, owner, artifact_ref, tenant_id`;
const DEFAULT_SEARCH_CANDIDATE_LIMIT = 200;

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
    metadata: parseJsonObject(row.metadata_json),
    created_at: row.created_at,
  };
}

function writeActiveTaskMirror(hippoRoot: string, snapshot: TaskSnapshot): void {
  const filePath = path.join(hippoRoot, 'buffer', 'active-task.md');
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

function removeActiveTaskMirror(hippoRoot: string): void {
  const filePath = path.join(hippoRoot, 'buffer', 'active-task.md');
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function writeRecentSessionMirror(hippoRoot: string, events: SessionEvent[]): void {
  const filePath = path.join(hippoRoot, 'buffer', 'recent-session.md');
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

function loadSearchRows(
  db: ReturnType<typeof openHippoDb>,
  query: string,
  limit: number,
  tenantId: string | undefined,
): MemoryRow[] {
  // tenantId undefined = no tenant filter (legacy callers / cross-deployment
  // helpers). tenantId set = strict tenant isolation, leveraging the composite
  // idx_memories_tenant_created (leading column tenant_id, O(log n) lookup).
  const tenantPredicate = tenantId !== undefined ? ` AND m.tenant_id = ?` : '';
  const tenantPredicateNoAlias = tenantId !== undefined ? ` AND tenant_id = ?` : '';
  const tenantOnlyPredicate = tenantId !== undefined ? ` WHERE tenant_id = ?` : '';
  const tenantParams = tenantId !== undefined ? [tenantId] : [];

  const terms = Array.from(new Set(tokenize(query)));
  if (terms.length === 0) {
    const sql = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories${tenantOnlyPredicate} ORDER BY created ASC, id ASC`;
    return db.prepare(sql).all(...tenantParams) as MemoryRow[];
  }

  if (isFtsAvailable(db)) {
    try {
      const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
      // memories_fts virtual table has no tenant_id column; filter via the
      // joined memories row (cheap with idx_memories_tenant_created leading
      // on tenant_id).
      const rows = db.prepare(`
        SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories m
        JOIN memories_fts f ON f.id = m.id
        WHERE memories_fts MATCH ?${tenantPredicate}
        ORDER BY bm25(memories_fts), m.updated_at DESC
        LIMIT ?
      `).all(ftsQuery, ...tenantParams, limit) as MemoryRow[];

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
    WHERE (${where})${tenantPredicateNoAlias}
    ORDER BY updated_at DESC, created DESC
    LIMIT ?
  `).all(...params, ...tenantParams, limit) as MemoryRow[];

  if (rows.length > 0) return rows;

  const fallback = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories${tenantOnlyPredicate} ORDER BY created ASC, id ASC`;
  return db.prepare(fallback).all(...tenantParams) as MemoryRow[];
}

function writeMarkdownMirror(hippoRoot: string, entry: MemoryEntry): void {
  removeEntryMirrors(hippoRoot, entry.id);
  const dir = layerDir(hippoRoot, entry.layer);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${entry.id}.md`), serializeEntry(entry), 'utf8');
}

function removeEntryMirrors(hippoRoot: string, id: string): void {
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
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
 */
export function writeEntry(hippoRoot: string, entry: MemoryEntry): void {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    upsertEntryRow(db, entry);
    writeMarkdownMirror(hippoRoot, entry);
    writeIndexMirror(hippoRoot, buildIndexFromDb(db));
    audit(db, 'remember', entry.id, {
      kind: entry.kind ?? 'distilled',
      scope: entry.scope ?? null,
    });
  } finally {
    closeHippoDb(db);
  }
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
 * Delete an entry from SQLite and mirrors.
 */
export function deleteEntry(hippoRoot: string, id: string): boolean {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const exists = db.prepare(`SELECT id FROM memories WHERE id = ?`).get(id) as { id?: string } | undefined;
    if (!exists?.id) return false;

    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    deleteFtsRow(db, id);
    removeEntryMirrors(hippoRoot, id);
    writeIndexMirror(hippoRoot, buildIndexFromDb(db));
    audit(db, 'forget', id);
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
    for (const entry of toWrite) {
      upsertEntryRow(db, entry);
    }
    for (const id of toDeleteIds) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      deleteFtsRow(db, id);
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

export function saveActiveTaskSnapshot(
  hippoRoot: string,
  snapshot: { task: string; summary: string; next_step: string; source?: string; session_id?: string | null }
): TaskSnapshot {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  const now = new Date().toISOString();

  try {
    db.exec('BEGIN');
    db.prepare(`UPDATE task_snapshots SET status = 'superseded', updated_at = ? WHERE status = 'active'`).run(now);

    const result = db.prepare(`
      INSERT INTO task_snapshots(task, summary, next_step, status, source, session_id, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      snapshot.task,
      snapshot.summary,
      snapshot.next_step,
      snapshot.source ?? 'cli',
      snapshot.session_id ?? null,
      now,
      now,
    );

    db.exec('COMMIT');

    const id = Number(result.lastInsertRowid ?? 0);
    const row = db.prepare(`
      SELECT id, task, summary, next_step, status, source, session_id, created_at, updated_at
      FROM task_snapshots
      WHERE id = ?
    `).get(id) as TaskSnapshotRow | undefined;

    if (!row) {
      throw new Error('Failed to reload saved active task snapshot');
    }

    const loaded = rowToTaskSnapshot(row);
    writeActiveTaskMirror(hippoRoot, loaded);
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

export function loadActiveTaskSnapshot(hippoRoot: string): TaskSnapshot | null {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`
      SELECT id, task, summary, next_step, status, source, session_id, created_at, updated_at
      FROM task_snapshots
      WHERE status = 'active'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get() as TaskSnapshotRow | undefined;

    if (!row) {
      removeActiveTaskMirror(hippoRoot);
      return null;
    }

    const loaded = rowToTaskSnapshot(row);
    writeActiveTaskMirror(hippoRoot, loaded);
    return loaded;
  } finally {
    closeHippoDb(db);
  }
}

export function clearActiveTaskSnapshot(hippoRoot: string, clearedStatus: string = 'cleared'): boolean {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  const now = new Date().toISOString();

  try {
    const active = db.prepare(`SELECT id FROM task_snapshots WHERE status = 'active' ORDER BY updated_at DESC, id DESC LIMIT 1`).get() as { id?: number } | undefined;
    if (!active?.id) {
      removeActiveTaskMirror(hippoRoot);
      return false;
    }

    db.prepare(`UPDATE task_snapshots SET status = ?, updated_at = ? WHERE id = ?`).run(clearedStatus, now, active.id);
    removeActiveTaskMirror(hippoRoot);
    return true;
  } finally {
    closeHippoDb(db);
  }
}

export function appendSessionEvent(
  hippoRoot: string,
  event: {
    session_id: string;
    event_type: string;
    content: string;
    task?: string | null;
    source?: string;
    metadata?: Record<string, unknown>;
  }
): SessionEvent {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  const now = new Date().toISOString();

  try {
    const result = db.prepare(`
      INSERT INTO session_events(session_id, task, event_type, content, source, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.session_id,
      event.task ?? null,
      event.event_type,
      event.content,
      event.source ?? 'cli',
      JSON.stringify(event.metadata ?? {}),
      now,
    );

    const id = Number(result.lastInsertRowid ?? 0);
    const row = db.prepare(`
      SELECT id, session_id, task, event_type, content, source, metadata_json, created_at
      FROM session_events
      WHERE id = ?
    `).get(id) as SessionEventRow | undefined;

    if (!row) {
      throw new Error('Failed to reload saved session event');
    }

    const loaded = rowToSessionEvent(row);
    // Query recent events inline using the already-open db handle
    // (avoids opening a second connection via listSessionEvents)
    const recentRows = db.prepare(`
      SELECT id, session_id, task, event_type, content, source, metadata_json, created_at
      FROM session_events
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(loaded.session_id, 20) as SessionEventRow[];
    const recent = recentRows.map(rowToSessionEvent).reverse();
    writeRecentSessionMirror(hippoRoot, recent);
    return loaded;
  } finally {
    closeHippoDb(db);
  }
}

export function listSessionEvents(
  hippoRoot: string,
  options: { session_id?: string; task?: string; limit?: number } = {}
): SessionEvent[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

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

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT id, session_id, task, event_type, content, source, metadata_json, created_at
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
  sinceMs: number,
): Array<{ session_id: string }> {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT DISTINCT session_id FROM session_events
      WHERE event_type = 'session_complete' AND created_at >= ?
    `).all(new Date(sinceMs).toISOString()) as { session_id: string }[];
    return rows;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Idempotency guard — true if a trace-layer memory with this source_session_id
 * already exists.
 */
export function traceExistsForSession(hippoRoot: string, session_id: string): boolean {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`
      SELECT 1 FROM memories
      WHERE source_session_id = ? AND layer = 'trace'
      LIMIT 1
    `).get(session_id);
    return !!row;
  } finally {
    closeHippoDb(db);
  }
}

export function listMemoryConflicts(hippoRoot: string, status: string = 'open'): MemoryConflict[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at
      FROM memory_conflicts
      WHERE status = ?
      ORDER BY updated_at DESC, id DESC
    `).all(status) as MemoryConflictRow[];
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
      if (!detectedKeys.has(key)) {
        db.prepare(`UPDATE memory_conflicts SET status = 'resolved', updated_at = ? WHERE id = ?`).run(detectedAt, row.id);
      }
    }

    for (const conflict of canonicalDetected) {
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
  forgetLoser: boolean = false
): { conflict: MemoryConflict; loserId: string } | null {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);

  try {
    const row = db.prepare(`
      SELECT id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at
      FROM memory_conflicts WHERE id = ?
    `).get(conflictId) as MemoryConflictRow | undefined;

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
      db.prepare(`DELETE FROM memories WHERE id = ?`).run(loserId);
    } else {
      // Halve the loser's half-life (weakens it over time)
      db.prepare(`UPDATE memories SET half_life_days = MAX(1, half_life_days / 2), updated_at = datetime('now') WHERE id = ?`)
        .run(loserId);
    }

    // Clean up conflicts_with references
    const keepRow = db.prepare(`SELECT conflicts_with_json FROM memories WHERE id = ?`).get(keepId) as { conflicts_with_json: string } | undefined;
    if (keepRow) {
      const refs: string[] = JSON.parse(keepRow.conflicts_with_json || '[]');
      const cleaned = refs.filter((r: string) => r !== loserId);
      db.prepare(`UPDATE memories SET conflicts_with_json = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(cleaned), keepId);
    }

    if (!forgetLoser) {
      const loserRow = db.prepare(`SELECT conflicts_with_json FROM memories WHERE id = ?`).get(loserId) as { conflicts_with_json: string } | undefined;
      if (loserRow) {
        const refs: string[] = JSON.parse(loserRow.conflicts_with_json || '[]');
        const cleaned = refs.filter((r: string) => r !== keepId);
        db.prepare(`UPDATE memories SET conflicts_with_json = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(JSON.stringify(cleaned), loserId);
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
  handoff: Omit<SessionHandoff, 'updatedAt'>,
): SessionHandoff {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  const now = new Date().toISOString();

  try {
    const result = db.prepare(`
      INSERT INTO session_handoffs(session_id, repo_root, task_id, summary, next_action, artifacts_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoff.sessionId,
      handoff.repoRoot ?? null,
      handoff.taskId ?? null,
      handoff.summary,
      handoff.nextAction ?? null,
      JSON.stringify(handoff.artifacts ?? []),
      now,
    );

    const id = Number(result.lastInsertRowid ?? 0);
    const row = db.prepare(`
      SELECT id, session_id, repo_root, task_id, summary, next_action, artifacts_json, created_at
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
export function loadLatestHandoff(hippoRoot: string, sessionId?: string): SessionHandoff | null {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);

  try {
    let row: SessionHandoffRow | undefined;
    if (sessionId) {
      row = db.prepare(`
        SELECT id, session_id, repo_root, task_id, summary, next_action, artifacts_json, created_at
        FROM session_handoffs
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(sessionId) as SessionHandoffRow | undefined;
    } else {
      row = db.prepare(`
        SELECT id, session_id, repo_root, task_id, summary, next_action, artifacts_json, created_at
        FROM session_handoffs
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get() as SessionHandoffRow | undefined;
    }

    return row ? rowToSessionHandoff(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Load a specific handoff by its row ID.
 */
export function loadHandoffById(hippoRoot: string, id: number): SessionHandoff | null {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);

  try {
    const row = db.prepare(`
      SELECT id, session_id, repo_root, task_id, summary, next_action, artifacts_json, created_at
      FROM session_handoffs
      WHERE id = ?
    `).get(id) as SessionHandoffRow | undefined;

    return row ? rowToSessionHandoff(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

export { getHippoDbPath };
