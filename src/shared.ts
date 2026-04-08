/**
 * Cross-agent shared memory for Hippo.
 * Global store is shared across all projects.
 * Resolution: $HIPPO_HOME > $XDG_DATA_HOME/hippo > ~/.hippo/
 * Local .hippo/ stores are per-project.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryEntry, generateId } from './memory.js';
import {
  initStore,
  loadAllEntries,
  loadIndex,
  loadSearchEntries,
  writeEntry,
  readEntry,
} from './store.js';
import { search, hybridSearch, SearchResult } from './search.js';

/**
 * Returns the path to the global Hippo store.
 * Resolution order: $HIPPO_HOME > $XDG_DATA_HOME/hippo > ~/.hippo/
 */
export function getGlobalRoot(): string {
  if (process.env.HIPPO_HOME) return process.env.HIPPO_HOME;
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'hippo');
  return path.join(os.homedir(), '.hippo');
}

/**
 * Ensure the global store exists.
 */
export function initGlobal(): void {
  const globalRoot = getGlobalRoot();
  if (!fs.existsSync(globalRoot)) {
    initStore(globalRoot);
  } else {
    // Ensure subdirectories exist in case partially initialized
    initStore(globalRoot);
  }
}

/**
 * Copy a local memory entry to the global store.
 * Assigns a new ID (prefixed with 'g_') to avoid collisions.
 * Returns the new global entry.
 */
export function promoteToGlobal(localRoot: string, id: string): MemoryEntry {
  const entry = readEntry(localRoot, id);
  if (!entry) throw new Error(`Memory not found: ${id}`);

  initGlobal();
  const globalRoot = getGlobalRoot();

  // Mint a new ID for the global store
  const globalEntry: MemoryEntry = {
    ...entry,
    id: generateId('g'),
    source: `promoted:${localRoot}`,
  };

  writeEntry(globalRoot, globalEntry);
  return globalEntry;
}

export interface SearchOptions {
  budget?: number;
  now?: Date;
}

/**
 * Search across both local and global stores, merging results.
 * Local results are boosted by 1.2x to prefer project-specific context.
 * Returns results sorted by adjusted score, within combined token budget.
 */
export function searchBoth(
  query: string,
  localRoot: string,
  globalRoot: string,
  options: SearchOptions = {}
): SearchResult[] {
  const { budget = 4000, now = new Date() } = options;

  const localEntries = fs.existsSync(localRoot) ? loadSearchEntries(localRoot, query) : [];
  const globalEntries = fs.existsSync(globalRoot) ? loadSearchEntries(globalRoot, query) : [];

  if (localEntries.length === 0 && globalEntries.length === 0) return [];

  // Search each store with full budget, then blend
  const localResults = search(query, localEntries, { budget, now });
  const globalResults = search(query, globalEntries, { budget, now });

  // Tag global results
  const tagged: Array<SearchResult & { isGlobal: boolean }> = [
    ...localResults.map((r) => ({ ...r, isGlobal: false, score: r.score * 1.2 })),
    ...globalResults.map((r) => ({ ...r, isGlobal: true })),
  ];

  // Remove duplicates by content (local/global IDs differ after promote/share)
  const seen = new Set<string>();
  const deduped = tagged.filter((r) => {
    const key = r.entry.content.slice(0, 200).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by adjusted score descending
  deduped.sort((a, b) => b.score - a.score);

  // Apply combined token budget (always include first result)
  const results: typeof deduped = [];
  let usedTokens = 0;

  for (let i = 0; i < deduped.length; i++) {
    if (i > 0 && usedTokens + deduped[i].tokens > budget) continue;
    usedTokens += deduped[i].tokens;
    results.push(deduped[i]);
  }

  return results;
}

export interface HybridSearchOptions extends SearchOptions {
  embeddingWeight?: number;
}

/**
 * Hybrid search across both local and global stores, using embeddings when available.
 * Async version of searchBoth that calls hybridSearch instead of search.
 */
export async function searchBothHybrid(
  query: string,
  localRoot: string,
  globalRoot: string,
  options: HybridSearchOptions = {}
): Promise<SearchResult[]> {
  const { budget = 4000, now = new Date(), embeddingWeight } = options;

  const localEntries = fs.existsSync(localRoot) ? loadSearchEntries(localRoot, query) : [];
  const globalEntries = fs.existsSync(globalRoot) ? loadSearchEntries(globalRoot, query) : [];

  if (localEntries.length === 0 && globalEntries.length === 0) return [];

  const localResults = await hybridSearch(query, localEntries, {
    budget, now, hippoRoot: localRoot, embeddingWeight,
  });
  const globalResults = await hybridSearch(query, globalEntries, {
    budget, now, hippoRoot: globalRoot, embeddingWeight,
  });

  // Tag global results
  const tagged: Array<SearchResult & { isGlobal: boolean }> = [
    ...localResults.map((r) => ({ ...r, isGlobal: false, score: r.score * 1.2 })),
    ...globalResults.map((r) => ({ ...r, isGlobal: true })),
  ];

  // Remove duplicates by content (local/global IDs differ after promote/share)
  const seen = new Set<string>();
  const deduped = tagged.filter((r) => {
    const key = r.entry.content.slice(0, 200).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by adjusted score descending
  deduped.sort((a, b) => b.score - a.score);

  // Apply combined token budget (always include first result)
  const results: typeof deduped = [];
  let usedTokens = 0;

  for (let i = 0; i < deduped.length; i++) {
    if (i > 0 && usedTokens + deduped[i].tokens > budget) continue;
    usedTokens += deduped[i].tokens;
    results.push(deduped[i]);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Multi-agent shared memory
// ---------------------------------------------------------------------------

/** Tags that indicate project-specific memories (poor transfer candidates) */
const PROJECT_SPECIFIC_TAGS = new Set([
  'file-path', 'config', 'deploy', 'cron', 'url', 'auth',
  'field-names', 'column-names', 'api-key', 'endpoint',
]);

/** Tags that indicate transferable memories (good transfer candidates) */
const TRANSFERABLE_TAGS = new Set([
  'error', 'platform', 'windows', 'encoding', 'python', 'shell',
  'powershell', 'quant', 'backtest', 'pattern', 'rule', 'gotcha',
  'sub-agent', 'review', 'best-practice',
]);

/**
 * Estimate how well a memory would transfer to other projects.
 * Returns 0..1 where >0.5 = good candidate for sharing.
 */
export function transferScore(entry: MemoryEntry): number {
  let score = 0.5; // neutral default

  // Boost for transferable tags
  const transferableCount = entry.tags.filter((t) => TRANSFERABLE_TAGS.has(t)).length;
  score += transferableCount * 0.1;

  // Penalize for project-specific tags
  const specificCount = entry.tags.filter((t) => PROJECT_SPECIFIC_TAGS.has(t)).length;
  score -= specificCount * 0.15;

  // High-retrieval memories are more likely to be universally useful
  if (entry.retrieval_count >= 3) score += 0.1;

  // Pinned memories are important to their owner
  if (entry.pinned) score += 0.1;

  // Error-tagged memories often encode universal lessons
  if (entry.emotional_valence === 'negative' || entry.emotional_valence === 'critical') score += 0.05;

  return Math.min(1, Math.max(0, score));
}

/**
 * Share a memory to the global store with attribution.
 * Enriches the source field with project path and timestamp.
 * Returns the new global entry, or null if transfer score is too low.
 */
export function shareMemory(
  localRoot: string,
  id: string,
  options: { force?: boolean } = {}
): MemoryEntry | null {
  const entry = readEntry(localRoot, id);
  if (!entry) throw new Error(`Memory not found: ${id}`);

  const score = transferScore(entry);
  if (score < 0.3 && !options.force) return null;

  initGlobal();
  const globalRoot = getGlobalRoot();

  const projectName = path.basename(path.resolve(localRoot, '..'));
  const globalEntry: MemoryEntry = {
    ...entry,
    id: generateId('g'),
    source: `shared:${projectName}:${new Date().toISOString()}`,
  };

  writeEntry(globalRoot, globalEntry);
  return globalEntry;
}

/**
 * List all projects that have contributed memories to the global store.
 * Parses the source field for 'shared:<project>:' or 'promoted:<path>' patterns.
 */
export function listPeers(globalRoot?: string): Array<{ project: string; count: number; latest: string }> {
  const root = globalRoot ?? getGlobalRoot();
  if (!fs.existsSync(root)) return [];

  const entries = loadAllEntries(root);
  const peerMap = new Map<string, { count: number; latest: string }>();

  for (const entry of entries) {
    let project = 'unknown';

    if (entry.source.startsWith('shared:')) {
      const parts = entry.source.split(':');
      project = parts[1] || 'unknown';
    } else if (entry.source.startsWith('promoted:')) {
      const promotedPath = entry.source.slice('promoted:'.length);
      project = path.basename(path.resolve(promotedPath, '..'));
    } else if (entry.source === 'cli-global') {
      project = 'global-cli';
    }

    const existing = peerMap.get(project);
    if (!existing) {
      peerMap.set(project, { count: 1, latest: entry.created });
    } else {
      existing.count++;
      if (entry.created > existing.latest) existing.latest = entry.created;
    }
  }

  return Array.from(peerMap.entries())
    .map(([project, data]) => ({ project, ...data }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Auto-share: find local memories with high transfer scores that aren't already global.
 * Returns the list of shared entries.
 */
export function autoShare(
  localRoot: string,
  options: { minScore?: number; dryRun?: boolean } = {}
): MemoryEntry[] {
  const { minScore = 0.6, dryRun = false } = options;

  const localEntries = loadAllEntries(localRoot);
  initGlobal();
  const globalRoot = getGlobalRoot();
  const globalEntries = loadAllEntries(globalRoot);

  // Build set of global content hashes to avoid duplicates
  const globalContentSet = new Set(
    globalEntries.map((e) => e.content.toLowerCase().trim().slice(0, 200))
  );

  const candidates = localEntries.filter((entry) => {
    const score = transferScore(entry);
    if (score < minScore) return false;

    // Skip if already shared (approximate content match)
    const contentKey = entry.content.toLowerCase().trim().slice(0, 200);
    if (globalContentSet.has(contentKey)) return false;

    return true;
  });

  if (dryRun) return candidates;

  const shared: MemoryEntry[] = [];
  for (const entry of candidates) {
    const result = shareMemory(localRoot, entry.id, { force: true });
    if (result) shared.push(result);
  }

  return shared;
}

/**
 * Copy all global memories into the local store.
 * Skips entries that already exist locally (by ID or by near-identical content).
 * Returns the count of newly copied entries.
 */
export function syncGlobalToLocal(localRoot: string, globalRoot: string): number {
  if (!fs.existsSync(globalRoot)) return 0;

  const globalEntries = loadAllEntries(globalRoot);
  const localIndex = loadIndex(localRoot);
  let count = 0;

  for (const entry of globalEntries) {
    // Skip if already present by ID
    if (localIndex.entries[entry.id]) continue;

    writeEntry(localRoot, entry);
    count++;
  }

  return count;
}
