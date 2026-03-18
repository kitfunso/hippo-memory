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

export { getHippoDbPath };
