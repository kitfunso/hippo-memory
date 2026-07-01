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
import { evalNow } from './ablation.js';
import { deriveOriginProject, classifyOriginProject } from './project-identity.js';
import { detectSecret } from './secret-detect.js';

/**
 * Returns the path to the global Hippo store.
 * Resolution order: $HIPPO_HOME > $XDG_DATA_HOME/hippo > ~/.hippo/
 */
export function getGlobalRoot(): string {
  const hippoHome = process.env.HIPPO_HOME?.trim();
  if (hippoHome) return hippoHome;
  const xdgData = process.env.XDG_DATA_HOME?.trim();
  if (xdgData) return path.join(xdgData, 'hippo');
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
export function promoteToGlobal(
  localRoot: string,
  id: string,
  opts?: { actor?: string; tenantId?: string },
): MemoryEntry {
  const entry = readEntry(localRoot, id, opts?.tenantId);
  if (!entry) throw new Error(`Memory not found: ${id}`);

  // v39 S4 producer veto: promote is a producer path to the global store
  // exactly like shareMemory - same hard rule (codex gating review P2).
  const promoteSecret = detectSecret(entry);
  if (promoteSecret.flagged) {
    throw new Error(
      `Refusing to promote ${id} to the global store: content matches secret material (${promoteSecret.reason}). ` +
      `Secrets stay in their owning project's store.`,
    );
  }

  initGlobal();
  const globalRoot = getGlobalRoot();

  // Mint a new ID for the global store. origin_project rides along from the
  // local entry's write-time stamp via the spread; back-stop it for pre-v39
  // local rows so a promoted copy never lands NULL in the global store.
  const globalEntry: MemoryEntry = {
    ...entry,
    id: generateId('g'),
    source: `promoted:${localRoot}`,
    origin_project: entry.origin_project ?? deriveOriginProject(path.dirname(path.resolve(localRoot))),
  };

  writeEntry(globalRoot, globalEntry, { actor: opts?.actor });
  return globalEntry;
}

export interface SearchOptions {
  budget?: number;
  now?: Date;
  minResults?: number;
  /** Tenant scope for both stores. Undefined = no filter (legacy single-tenant). */
  tenantId?: string;
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
  const { budget = 4000, now = evalNow(), minResults, tenantId } = options;
  const effectiveMin = minResults ?? 1;

  const localEntries = fs.existsSync(localRoot) ? loadSearchEntries(localRoot, query, undefined, tenantId) : [];
  const globalEntries = fs.existsSync(globalRoot) ? loadSearchEntries(globalRoot, query, undefined, tenantId) : [];

  if (localEntries.length === 0 && globalEntries.length === 0) return [];

  // Search each store with full budget, then blend
  const localResults = search(query, localEntries, { budget, now, minResults });
  const globalResults = search(query, globalEntries, { budget, now, minResults });

  // Tag global results. Local memories get a configurable priority bump.
  const syncLocalBump = 1.2;
  const tagged: Array<SearchResult & { isGlobal: boolean }> = [
    ...localResults.map((r) => ({
      ...r,
      isGlobal: false,
      score: r.score * syncLocalBump,
      breakdown: r.breakdown
        ? { ...r.breakdown, sourceBump: syncLocalBump, final: r.breakdown.final * syncLocalBump }
        : undefined,
    })),
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

  // Apply combined token budget (guarantee at least minResults items)
  const results: typeof deduped = [];
  let usedTokens = 0;

  for (let i = 0; i < deduped.length; i++) {
    if (results.length >= effectiveMin && usedTokens + deduped[i].tokens > budget) continue;
    usedTokens += deduped[i].tokens;
    results.push(deduped[i]);
  }

  return results;
}

export interface HybridSearchOptions extends SearchOptions {
  embeddingWeight?: number;
  explain?: boolean;
  mmr?: boolean;
  mmrLambda?: number;
  /** Multiplier applied to local-store scores when merging with global.
   *  Defaults to 1.2. Use 1.0 to remove the local bias for eval comparisons. */
  localBump?: number;
  /** Active scope for scope-boost scoring. Auto-detected if not provided. */
  scope?: string | null;
  /** Include superseded memories in results. Default false. */
  includeSuperseded?: boolean;
  /** Filter to memories current at this ISO date string. */
  asOf?: string;
  /** v0.30 / E4 — propagated to underlying hybridSearch calls.
   *  Per-call > env HIPPO_SUMMARY_DEBOOST > 0.85 default. */
  summaryDeboost?: number;
  /** v0.30 / E4 — propagated. Default true (1.05 boost if rebuilt within 7d). */
  summaryFreshness?: boolean;
  /** v39 memory scope isolation: optional admission predicate applied to the
   *  loaded candidate entries of BOTH stores BEFORE ranking, cross-store
   *  content-dedupe, and budgeting. Without it, an excluded row can shadow
   *  its admitted duplicate in the dedupe pass, or saturate the budget.
   *  Default undefined = unchanged behavior (recall paths never set it). */
  entryFilter?: (entry: MemoryEntry) => boolean;
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
  const { budget = 4000, now = evalNow(), embeddingWeight, explain, mmr, mmrLambda, localBump = 1.2, minResults, scope, includeSuperseded, asOf, tenantId, summaryDeboost, summaryFreshness, entryFilter } = options;

  let localEntries = fs.existsSync(localRoot) ? loadSearchEntries(localRoot, query, undefined, tenantId) : [];
  let globalEntries = fs.existsSync(globalRoot) ? loadSearchEntries(globalRoot, query, undefined, tenantId) : [];
  if (entryFilter) {
    localEntries = localEntries.filter(entryFilter);
    globalEntries = globalEntries.filter(entryFilter);
  }

  if (localEntries.length === 0 && globalEntries.length === 0) return [];

  const localResults = await hybridSearch(query, localEntries, {
    budget, now, hippoRoot: localRoot, embeddingWeight, explain, mmr, mmrLambda, minResults, scope, includeSuperseded, asOf, summaryDeboost, summaryFreshness,
  });
  const globalResults = await hybridSearch(query, globalEntries, {
    budget, now, hippoRoot: globalRoot, embeddingWeight, explain, mmr, mmrLambda, minResults, scope, includeSuperseded, asOf, summaryDeboost, summaryFreshness,
  });

  // Tag global results. Local memories get a configurable priority bump.
  const tagged: Array<SearchResult & { isGlobal: boolean }> = [
    ...localResults.map((r) => ({
      ...r,
      isGlobal: false,
      score: r.score * localBump,
      breakdown: r.breakdown
        ? { ...r.breakdown, sourceBump: localBump, final: r.breakdown.final * localBump }
        : undefined,
    })),
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

  // Apply combined token budget (guarantee at least minResults items)
  const effectiveMinHybrid = minResults ?? 1;
  const results: typeof deduped = [];
  let usedTokens = 0;

  for (let i = 0; i < deduped.length; i++) {
    if (results.length >= effectiveMinHybrid && usedTokens + deduped[i].tokens > budget) continue;
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
  options: { force?: boolean; tenantId?: string } = {}
): MemoryEntry | null {
  // tenantId is OPTIONAL for backward compat — autoShare's internal call at
  // :370 passes only `{ force: true }` in a single-tenant context. MCP/REST
  // hosts MUST pass tenantId so a Bearer for tenant A cannot share tenant
  // B's memory to global. readEntry returns null on cross-tenant lookups
  // when tenantId is provided.
  const entry = readEntry(localRoot, id, options.tenantId);
  if (!entry) throw new Error(`Memory not found: ${id}`);

  // v39 S4 producer veto: secrets never go to the global store, not even
  // with --force. Explicit and loud - a silent null would read as "low
  // transfer score" and invite retries.
  const secret = detectSecret(entry);
  if (secret.flagged) {
    throw new Error(
      `Refusing to share ${id} to the global store: content matches secret material (${secret.reason}). ` +
      `Secrets stay in their owning project's store.`,
    );
  }

  const score = transferScore(entry);
  if (score < 0.3 && !options.force) return null;

  initGlobal();
  const globalRoot = getGlobalRoot();

  // v39: canonical origin comes from the entry's own stamp (write-time,
  // store-location-derived); the localRoot parent basename is only a
  // fallback for pre-v39 rows and keeps the legacy source format intact.
  const fallbackName = path.basename(path.resolve(localRoot, '..'));
  const originName = entry.origin_project ?? deriveOriginProject(path.dirname(path.resolve(localRoot)));
  const globalEntry: MemoryEntry = {
    ...entry,
    id: generateId('g'),
    source: `shared:${originName === '' ? fallbackName : originName}:${new Date().toISOString()}`,
    origin_project: originName,
  };

  writeEntry(globalRoot, globalEntry);
  return globalEntry;
}

/**
 * List all projects that have contributed memories to the global store.
 * Parses the source field for 'shared:<project>:' or 'promoted:<path>' patterns.
 *
 * D4 v1.12.10: `tenantId` is now optional. When provided, the global entries
 * are filtered to that tenant before aggregation — matches every other
 * read path's default-safe behaviour. When undefined, host-wide (back-compat
 * for legacy callers like CLI standalone + dashboard internal use). Operators
 * who genuinely want cross-tenant peer discovery can pass undefined or
 * use direct SQL.
 */
export function listPeers(
  globalRoot?: string,
  tenantId?: string,
): Array<{ project: string; count: number; latest: string }> {
  const root = globalRoot ?? getGlobalRoot();
  if (!fs.existsSync(root)) return [];

  // D4: tenant-scoped by default when tenantId provided. Host-wide when
  // undefined (preserves back-compat).
  const allEntries = loadAllEntries(root);
  const entries = tenantId !== undefined
    ? allEntries.filter((e) => e.tenantId === tenantId)
    : allEntries;
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
 *
 * L9: `options.tenantId` is opt-in. When provided, the LOCAL-entries read is
 * scoped to that tenant. When undefined, the local read is host-wide (current
 * behaviour). The GLOBAL-entries read is always unioned — the global root IS
 * the cross-tenant aggregate by design. The only intentional unscoped
 * internal caller as of v1.12.1 is `api.sleep` (`src/api.ts:2041`), which
 * passes options without tenantId because `sleep` is host-wide by intent;
 * see `src/api.ts:2073-2077` for the cross-tenant dedup rationale.
 */
export function autoShare(
  localRoot: string,
  options: { minScore?: number; dryRun?: boolean; tenantId?: string } = {},
): MemoryEntry[] {
  const { minScore = 0.6, dryRun = false } = options;

  const localEntries = loadAllEntries(localRoot, options.tenantId);
  initGlobal();
  const globalRoot = getGlobalRoot();
  // L9: host-wide read. The global store IS the union across all tenants;
  // per-tenant filtering on the global root would defeat the purpose.
  const globalEntries = loadAllEntries(globalRoot);

  // Build set of global content hashes to avoid duplicates
  const globalContentSet = new Set(
    globalEntries.map((e) => e.content.toLowerCase().trim().slice(0, 200))
  );

  const candidates = localEntries.filter((entry) => {
    // v39 S4 producer veto: secret rows never auto-share, regardless of
    // transfer score. (shareMemory would throw; filtering here keeps the
    // sleep pipeline fail-safe.)
    if (detectSecret(entry).flagged) return false;

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
export function syncGlobalToLocal(
  localRoot: string,
  globalRoot: string,
  opts: { includeCrossProject?: boolean } = {},
): number {
  if (!fs.existsSync(globalRoot)) return 0;

  // L9: host-wide read. syncGlobalToLocal copies the global union into a
  // tenant-scoped local store; writeEntry on each row carries the tenant if
  // the local-root context provides one.
  const globalEntries = loadAllEntries(globalRoot);
  const localIndex = loadIndex(localRoot);

  // v39 (codex P1-4): syncing down must not re-import what ambient context
  // excludes - other-project rows are skipped by default and secret rows
  // are never copied. origin_project is preserved on the copy (writeEntry
  // only stamps when the field is missing).
  const currentName = deriveOriginProject(path.dirname(path.resolve(localRoot)));
  let count = 0;

  for (const entry of globalEntries) {
    // Skip if already present by ID
    if (localIndex.entries[entry.id]) continue;
    if (detectSecret(entry).flagged) continue;
    if (
      !opts.includeCrossProject &&
      classifyOriginProject(entry.origin_project, currentName) === 'cross-project'
    ) continue;

    writeEntry(localRoot, entry);
    count++;
  }

  return count;
}
