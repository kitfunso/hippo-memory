/**
 * Storage layer for Hippo.
 *
 * SQLite is the source of truth.
 * Markdown + JSON files remain as human-readable compatibility mirrors.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MemoryEntry, Layer, ConfidenceLevel } from './memory.js';
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
  conflicts_with_json: string;
  pinned: number;
  confidence: ConfidenceLevel;
  content: string;
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

const INDEX_VERSION = 2;
const MEMORY_SELECT_COLUMNS = `id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, outcome_score, conflicts_with_json, pinned, confidence, content`;
const DEFAULT_SEARCH_CANDIDATE_LIMIT = 200;

function layerDir(root: string, layer: Layer): string {
  return path.join(root, layer);
}

export function getHippoRoot(cwd: string = process.cwd()): string {
  return path.join(cwd, '.hippo');
}

export function isInitialized(hippoRoot: string): boolean {
  return fs.existsSync(hippoRoot);
}

export function initStore(hippoRoot: string): void {
  ensureMirrorDirectories(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    bootstrapLegacyStore(db, hippoRoot);
    syncMirrorFiles(hippoRoot, db);
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
  const fm = dumpFrontmatter({
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
    conflicts_with: entry.conflicts_with,
    pinned: entry.pinned,
    confidence: entry.confidence ?? 'observed',
  });
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
    conflicts_with: normalizeStringArray(data['conflicts_with']),
    pinned: Boolean(data['pinned'] ?? false),
    confidence: (data['confidence'] as ConfidenceLevel) ?? 'observed',
    content: content.trim(),
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
    conflicts_with: parseJsonArray(row.conflicts_with_json),
    pinned: Boolean(row.pinned),
    confidence: row.confidence ?? 'observed',
    content: row.content,
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

function tokenizeSearchQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 1);
}

function loadSearchRows(db: ReturnType<typeof openHippoDb>, query: string, limit: number): MemoryRow[] {
  const terms = Array.from(new Set(tokenizeSearchQuery(query)));
  if (terms.length === 0) {
    return db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ORDER BY created ASC, id ASC`).all() as MemoryRow[];
  }

  if (isFtsAvailable(db)) {
    try {
      const ftsQuery = terms.map((term) => `${term.replace(/"/g, '""')}*`).join(' OR ');
      const rows = db.prepare(`
        SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories m
        JOIN memories_fts f ON f.id = m.id
        WHERE memories_fts MATCH ?
        ORDER BY bm25(memories_fts), m.updated_at DESC
        LIMIT ?
      `).all(ftsQuery, limit) as MemoryRow[];

      if (rows.length > 0) return rows;
    } catch {
      // Fall back to LIKE matching below.
    }
  }

  const where = terms.map(() => `(LOWER(content) LIKE ? OR LOWER(tags_json) LIKE ?)` ).join(' OR ');
  const params = terms.flatMap((term) => {
    const like = `%${term}%`;
    return [like, like];
  });

  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${where}
    ORDER BY updated_at DESC, created DESC
    LIMIT ?
  `).all(...params, limit) as MemoryRow[];

  if (rows.length > 0) return rows;

  return db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ORDER BY created ASC, id ASC`).all() as MemoryRow[];
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

function bootstrapLegacyStore(db: ReturnType<typeof openHippoDb>, hippoRoot: string): void {
  const countRow = db.prepare(`SELECT COUNT(*) AS count FROM memories`).get() as { count?: number } | undefined;
  const memoryCount = Number(countRow?.count ?? 0);
  if (memoryCount > 0) return;

  const legacyEntries = loadLegacyEntriesFromMarkdown(hippoRoot);
  if (legacyEntries.length === 0) return;

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
      conflicts_with_json, pinned, confidence, content, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
      conflicts_with_json = excluded.conflicts_with_json,
      pinned = excluded.pinned,
      confidence = excluded.confidence,
      content = excluded.content,
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
    JSON.stringify(entry.conflicts_with ?? []),
    entry.pinned ? 1 : 0,
    entry.confidence,
    entry.content,
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
  const entries = db.prepare(`SELECT id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, outcome_score, conflicts_with_json, pinned, confidence, content FROM memories ORDER BY created ASC, id ASC`).all() as MemoryRow[];

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
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Read a memory entry by ID.
 */
export function readEntry(hippoRoot: string, id: string): MemoryEntry | null {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`SELECT id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, outcome_score, conflicts_with_json, pinned, confidence, content FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
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
    return true;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Load all entries from SQLite.
 */
export function loadAllEntries(hippoRoot: string): MemoryEntry[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ORDER BY created ASC, id ASC`).all() as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Load likely search candidates directly from SQLite.
 * Uses FTS5 when available, falls back to LIKE matching, then full-store fallback.
 */
export function loadSearchEntries(
  hippoRoot: string,
  query: string,
  limit: number = DEFAULT_SEARCH_CANDIDATE_LIMIT
): MemoryEntry[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    return loadSearchRows(db, query, limit).map(rowToEntry);
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
      for (const entry of legacyEntries) {
        upsertEntryRow(db, entry);
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
    const recent = listSessionEvents(hippoRoot, { session_id: loaded.session_id, limit: 20 });
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

export { getHippoDbPath };
