/**
 * Storage layer for Hippo.
 * Reads/writes MemoryEntry as markdown + YAML frontmatter.
 * Maintains a JSON index for fast lookups.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MemoryEntry, Layer, ConfidenceLevel, calculateStrength } from './memory.js';
import { dumpFrontmatter, parseFrontmatter } from './yaml.js';

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
  last_retrieval_ids: string[];  // ids returned by last recall
}

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
  const dirs = [
    hippoRoot,
    path.join(hippoRoot, 'buffer'),
    path.join(hippoRoot, 'episodic'),
    path.join(hippoRoot, 'semantic'),
    path.join(hippoRoot, 'conflicts'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const indexPath = path.join(hippoRoot, 'index.json');
  if (!fs.existsSync(indexPath)) {
    const empty: HippoIndex = { version: 1, entries: {}, last_retrieval_ids: [] };
    fs.writeFileSync(indexPath, JSON.stringify(empty, null, 2), 'utf8');
  }

  const statsPath = path.join(hippoRoot, 'stats.json');
  if (!fs.existsSync(statsPath)) {
    const stats = {
      total_remembered: 0,
      total_recalled: 0,
      total_forgotten: 0,
      consolidation_runs: [],
    };
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf8');
  }
}

export function loadIndex(hippoRoot: string): HippoIndex {
  const indexPath = path.join(hippoRoot, 'index.json');
  if (!fs.existsSync(indexPath)) {
    return { version: 1, entries: {}, last_retrieval_ids: [] };
  }
  return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as HippoIndex;
}

export function saveIndex(hippoRoot: string, index: HippoIndex): void {
  const indexPath = path.join(hippoRoot, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
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
    tags: (data['tags'] as string[]) ?? [],
    emotional_valence: (data['emotional_valence'] as MemoryEntry['emotional_valence']) ?? 'neutral',
    schema_fit: Number(data['schema_fit'] ?? 0.5),
    source: String(data['source'] ?? 'cli'),
    outcome_score: data['outcome_score'] === null ? null : Number(data['outcome_score']),
    conflicts_with: (data['conflicts_with'] as string[]) ?? [],
    pinned: Boolean(data['pinned'] ?? false),
    confidence: (data['confidence'] as ConfidenceLevel) ?? 'observed',
    content: content.trim(),
  };
}

/**
 * Write a memory entry to disk and update the index.
 */
export function writeEntry(hippoRoot: string, entry: MemoryEntry): void {
  const dir = layerDir(hippoRoot, entry.layer);
  const filename = `${entry.id}.md`;
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, serializeEntry(entry), 'utf8');

  // Update index
  const index = loadIndex(hippoRoot);
  index.entries[entry.id] = {
    id: entry.id,
    file: path.join(entry.layer, filename),
    layer: entry.layer,
    strength: entry.strength,
    tags: entry.tags,
    created: entry.created,
    last_retrieved: entry.last_retrieved,
    pinned: entry.pinned,
  };
  saveIndex(hippoRoot, index);
}

/**
 * Read a memory entry by ID.
 */
export function readEntry(hippoRoot: string, id: string): MemoryEntry | null {
  const index = loadIndex(hippoRoot);
  const ref = index.entries[id];
  if (!ref) return null;

  const filepath = path.join(hippoRoot, ref.file);
  if (!fs.existsSync(filepath)) return null;

  const raw = fs.readFileSync(filepath, 'utf8');
  return deserializeEntry(raw);
}

/**
 * Delete an entry from disk and index.
 */
export function deleteEntry(hippoRoot: string, id: string): boolean {
  const index = loadIndex(hippoRoot);
  const ref = index.entries[id];
  if (!ref) return false;

  const filepath = path.join(hippoRoot, ref.file);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
  }

  delete index.entries[id];
  saveIndex(hippoRoot, index);
  return true;
}

/**
 * Load all entries from disk (for search, consolidation, etc.)
 */
export function loadAllEntries(hippoRoot: string): MemoryEntry[] {
  const index = loadIndex(hippoRoot);
  const entries: MemoryEntry[] = [];

  for (const ref of Object.values(index.entries)) {
    const filepath = path.join(hippoRoot, ref.file);
    if (!fs.existsSync(filepath)) continue;
    const raw = fs.readFileSync(filepath, 'utf8');
    const entry = deserializeEntry(raw);
    if (entry) entries.push(entry);
  }

  return entries;
}

/**
 * Rebuild the index from all markdown files on disk.
 */
export function rebuildIndex(hippoRoot: string): HippoIndex {
  const index: HippoIndex = { version: 1, entries: {}, last_retrieval_ids: [] };
  const layers = [Layer.Buffer, Layer.Episodic, Layer.Semantic];

  for (const layer of layers) {
    const dir = layerDir(hippoRoot, layer);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filepath = path.join(dir, file);
      const raw = fs.readFileSync(filepath, 'utf8');
      const entry = deserializeEntry(raw);
      if (!entry) continue;

      index.entries[entry.id] = {
        id: entry.id,
        file: path.join(layer, file),
        layer: entry.layer,
        strength: entry.strength,
        tags: entry.tags,
        created: entry.created,
        last_retrieved: entry.last_retrieved,
        pinned: entry.pinned,
      };
    }
  }

  saveIndex(hippoRoot, index);
  return index;
}

/**
 * Update stats file.
 */
export function updateStats(
  hippoRoot: string,
  delta: { remembered?: number; recalled?: number; forgotten?: number }
): void {
  const statsPath = path.join(hippoRoot, 'stats.json');
  let stats = { total_remembered: 0, total_recalled: 0, total_forgotten: 0, consolidation_runs: [] as unknown[] };

  if (fs.existsSync(statsPath)) {
    stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  }

  if (delta.remembered) stats.total_remembered += delta.remembered;
  if (delta.recalled) stats.total_recalled += delta.recalled;
  if (delta.forgotten) stats.total_forgotten += delta.forgotten;

  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf8');
}

export function loadStats(hippoRoot: string): Record<string, unknown> {
  const statsPath = path.join(hippoRoot, 'stats.json');
  if (!fs.existsSync(statsPath)) return {};
  return JSON.parse(fs.readFileSync(statsPath, 'utf8'));
}

export function appendConsolidationRun(
  hippoRoot: string,
  run: { timestamp: string; decayed: number; merged: number; removed: number }
): void {
  const statsPath = path.join(hippoRoot, 'stats.json');
  const stats = fs.existsSync(statsPath)
    ? (JSON.parse(fs.readFileSync(statsPath, 'utf8')) as { consolidation_runs: unknown[] })
    : { consolidation_runs: [] };

  if (!Array.isArray(stats.consolidation_runs)) stats.consolidation_runs = [];
  stats.consolidation_runs.push(run);

  // Keep last 50 runs
  if (stats.consolidation_runs.length > 50) {
    stats.consolidation_runs = stats.consolidation_runs.slice(-50);
  }

  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf8');
}
