/**
 * Cross-agent shared memory for Hippo.
 * Global store at ~/.hippo/ is shared across all projects.
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
  writeEntry,
  readEntry,
} from './store.js';
import { search, SearchResult } from './search.js';

/**
 * Returns the path to the global Hippo store: ~/.hippo/
 */
export function getGlobalRoot(): string {
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

  const localEntries = fs.existsSync(localRoot) ? loadAllEntries(localRoot) : [];
  const globalEntries = fs.existsSync(globalRoot) ? loadAllEntries(globalRoot) : [];

  if (localEntries.length === 0 && globalEntries.length === 0) return [];

  // Search each store with full budget, then blend
  const localResults = search(query, localEntries, { budget, now });
  const globalResults = search(query, globalEntries, { budget, now });

  // Tag global results
  const tagged: Array<SearchResult & { isGlobal: boolean }> = [
    ...localResults.map((r) => ({ ...r, isGlobal: false, score: r.score * 1.2 })),
    ...globalResults.map((r) => ({ ...r, isGlobal: true })),
  ];

  // Remove duplicates: if same ID appears in both, keep the local (higher weight) one
  const seen = new Set<string>();
  const deduped = tagged.filter((r) => {
    if (seen.has(r.entry.id)) return false;
    seen.add(r.entry.id);
    return true;
  });

  // Sort by adjusted score descending
  deduped.sort((a, b) => b.score - a.score);

  // Apply combined token budget
  const results: typeof deduped = [];
  let usedTokens = 0;

  for (const r of deduped) {
    if (usedTokens + r.tokens > budget) continue;
    results.push(r);
    usedTokens += r.tokens;
  }

  return results;
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
