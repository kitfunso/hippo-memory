/** Cross-agent shared memory. Global store spans all projects (resolved $HIPPO_HOME > $XDG_DATA_HOME/hippo > ~/.hippo/); local .hippo/ stores are per-project. */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryEntry, generateId } from './memory.js';
import {
  initStore,
  loadAllEntries,
  loadIndex,
  loadSearchEntries,
  loadRecallSearchEntries,
  writeEntry,
  readEntry,
} from './store.js';
import { passesScopeFilterForRecall, passesCliRecallScopeFilter } from './recall-scope.js';
import { search, hybridSearch, SearchResult } from './search.js';
import { evalNow } from './ablation.js';
import { deriveOriginProject, classifyOriginProject, resolveGlobalRootDir } from './project-identity.js';
import { detectSecret } from './secret-detect.js';
import { embedMemory, embedAll } from './embeddings.js';

export function getGlobalRoot(): string {
  // Single source of truth lives in project-identity.ts so db.ts migrations can resolve the same path without a shared.ts import cycle.
  return resolveGlobalRootDir();
}

export function initGlobal(): void {
  const globalRoot = getGlobalRoot();
  if (!fs.existsSync(globalRoot)) {
    initStore(globalRoot);
  } else {
    // Ensure subdirectories exist in case partially initialized
    initStore(globalRoot);
  }
}

/** Copies a local entry to the global store under a new 'g_'-prefixed ID (avoids ID collisions). */
export function promoteToGlobal(
  localRoot: string,
  id: string,
  opts?: { actor?: string; tenantId?: string },
): MemoryEntry {
  const entry = readEntry(localRoot, id, opts?.tenantId);
  if (!entry) throw new Error(`Memory not found: ${id}`);

  // Producer veto: promote is a producer path to the global store, same hard rule as shareMemory.
  const promoteSecret = detectSecret(entry);
  if (promoteSecret.flagged) {
    throw new Error(
      `Refusing to promote ${id} to the global store: content matches secret material (${promoteSecret.reason}). ` +
      `Secrets stay in their owning project's store.`,
    );
  }

  initGlobal();
  const globalRoot = getGlobalRoot();

  // origin_project rides along via the spread; back-stopped here for pre-v39 rows so a promoted copy never lands NULL.
  const globalEntry: MemoryEntry = {
    ...entry,
    id: generateId('g'),
    source: `promoted:${localRoot}`,
    origin_project: entry.origin_project ?? deriveOriginProject(path.dirname(path.resolve(localRoot))),
  };

  writeEntry(globalRoot, globalEntry, { actor: opts?.actor });

  // Fire-and-forget: embedMemory's own availability gate already no-ops when embeddings are disabled, so no pre-guard needed here.
  void embedMemory(globalRoot, globalEntry).catch(() => {});

  return globalEntry;
}

export interface SearchOptions {
  budget?: number;
  now?: Date;
  minResults?: number;
  /** Tenant scope for both stores. Undefined = no filter (legacy single-tenant). */
  tenantId?: string;
}

/** Searches both stores and merges; local results get a 1.2x score boost to prefer project-specific context. */
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

  const localResults = search(query, localEntries, { budget, now, minResults });
  const globalResults = search(query, globalEntries, { budget, now, minResults });

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

  // Stable sort on purpose: local/global inputs are each deterministically ordered, and an exact post-bump tie keeps the local result ahead (concat order).
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
  /** Multiplier applied to local-store scores when merging with global (default 1.2; use 1.0 to remove local bias for eval comparisons). */
  localBump?: number;
  /** Active scope for scope-boost scoring. Auto-detected if not provided. */
  scope?: string | null;
  /** Include superseded memories in results. Default false. */
  includeSuperseded?: boolean;
  /** Filter to memories current at this ISO date string. */
  asOf?: string;
  /** Propagated to underlying hybridSearch calls; per-call > env HIPPO_SUMMARY_DEBOOST > 0.85 default. */
  summaryDeboost?: number;
  /** Propagated to underlying hybridSearch calls; default true (1.05 boost if rebuilt within 7d). */
  summaryFreshness?: boolean;
  /** Admission predicate applied before ranking/dedupe/budgeting on both stores; without it an excluded row can shadow its duplicate or saturate the budget. */
  entryFilter?: (entry: MemoryEntry) => boolean;
  /** Recall-mode scope filter for searchBothHybrid only; absent = unfiltered (loadSearchEntries). Present switches to loadRecallSearchEntries + JS post-filter: `{}` = default-deny, `{requested}` = exact match, `{requested, additive:true}` = default-admitted set plus requested (see docs/ARCHITECTURE.md). */
  recallScope?: { requested?: string; additive?: boolean };
}

/** Async, embeddings-aware counterpart to searchBoth (calls hybridSearch instead of search). */
export async function searchBothHybrid(
  query: string,
  localRoot: string,
  globalRoot: string,
  options: HybridSearchOptions = {}
): Promise<SearchResult[]> {
  const { budget = 4000, now = evalNow(), embeddingWeight, explain, mmr, mmrLambda, localBump = 1.2, minResults, scope, includeSuperseded, asOf, tenantId, summaryDeboost, summaryFreshness, entryFilter, recallScope } = options;

  // When entryFilter is active, lift the per-store candidate cap to 5000 (25x default 200) so excluded rows can't crowd out admitted ones before the window fills (see docs/ARCHITECTURE.md).
  const searchWindow = entryFilter ? 5000 : undefined;
  // Recall mode pushes the scope predicate into SQL like api.recall, so quarantine/private rows never enter the candidate set; the JS post-filter below is defense-in-depth on top.
  const loadEntries = (root: string): MemoryEntry[] => {
    if (!fs.existsSync(root)) return [];
    return recallScope
      ? loadRecallSearchEntries(
          root, query, searchWindow, tenantId, recallScope.requested,
          recallScope.additive ? 'additive' : 'exact',
        )
      : loadSearchEntries(root, query, searchWindow, tenantId);
  };
  let localEntries = loadEntries(localRoot);
  let globalEntries = loadEntries(globalRoot);
  if (recallScope) {
    const passes = (e: MemoryEntry) =>
      recallScope.additive
        ? passesCliRecallScopeFilter(e.scope ?? null, recallScope.requested)
        : passesScopeFilterForRecall(e.scope ?? null, recallScope.requested);
    localEntries = localEntries.filter(passes);
    globalEntries = globalEntries.filter(passes);
  }
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

  // Stable sort on purpose (same rationale as searchBoth: deterministic inputs, local-first on ties).
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

/** Transfer-fit score 0..1; >0.5 = good candidate for sharing to the global store. */
export function transferScore(entry: MemoryEntry): number {
  let score = 0.5; // neutral default

  const transferableCount = entry.tags.filter((t) => TRANSFERABLE_TAGS.has(t)).length;
  score += transferableCount * 0.1;

  const specificCount = entry.tags.filter((t) => PROJECT_SPECIFIC_TAGS.has(t)).length;
  score -= specificCount * 0.15;

  if (entry.retrieval_count >= 3) score += 0.1;

  if (entry.pinned) score += 0.1;

  if (entry.emotional_valence === 'negative' || entry.emotional_valence === 'critical') score += 0.05;

  return Math.min(1, Math.max(0, score));
}

/** Shares a memory to the global store with attribution (source enriched with project path + timestamp); returns null if transfer score is too low and not forced. */
export function shareMemory(
  localRoot: string,
  id: string,
  options: { force?: boolean; tenantId?: string; skipEmbed?: boolean } = {}
): MemoryEntry | null {
  // tenantId is optional for back-compat, but MCP/REST hosts MUST pass it so a tenant-A bearer can't share tenant B's memory.
  const entry = readEntry(localRoot, id, options.tenantId);
  if (!entry) throw new Error(`Memory not found: ${id}`);

  // Secrets never go to the global store, not even with --force; throw loud rather than a silent null that reads as "low transfer score".
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

  // Canonical origin is the entry's own write-time stamp; the localRoot parent basename is only a fallback for pre-v39 rows.
  const fallbackName = path.basename(path.resolve(localRoot, '..'));
  const originName = entry.origin_project ?? deriveOriginProject(path.dirname(path.resolve(localRoot)));
  const globalEntry: MemoryEntry = {
    ...entry,
    id: generateId('g'),
    source: `shared:${originName === '' ? fallbackName : originName}:${new Date().toISOString()}`,
    origin_project: originName,
  };

  writeEntry(globalRoot, globalEntry);

  // Embeds here unless the caller opts out; autoShare sets skipEmbed to batch through one embedAll() instead of N full-index rewrites.
  if (!options.skipEmbed) {
    void embedMemory(globalRoot, globalEntry).catch(() => {});
  }

  return globalEntry;
}

/** Lists projects that contributed to the global store (parses 'shared:<project>:' / 'promoted:<path>' source patterns). tenantId optional: filters when provided, host-wide when undefined (back-compat). */
export function listPeers(
  globalRoot?: string,
  tenantId?: string,
): Array<{ project: string; count: number; latest: string }> {
  const root = globalRoot ?? getGlobalRoot();
  if (!fs.existsSync(root)) return [];

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

/** Finds local memories with high transfer scores not already global, and shares them; tenantId scopes the local read only (global is always the cross-tenant union — see docs/ARCHITECTURE.md). stats.secretSkipped (opt-in out-param) counts rows withheld solely by the secret veto after passing every other gate. */
export function autoShare(
  localRoot: string,
  options: { minScore?: number; dryRun?: boolean; tenantId?: string; stats?: { secretSkipped: number } } = {},
): MemoryEntry[] {
  const { minScore = 0.6, dryRun = false } = options;

  const localEntries = loadAllEntries(localRoot, options.tenantId);
  initGlobal();
  const globalRoot = getGlobalRoot();
  // Host-wide read: the global store IS the union across all tenants; per-tenant filtering here would defeat the purpose.
  const globalEntries = loadAllEntries(globalRoot);

  // Build set of global content hashes to avoid duplicates
  const globalContentSet = new Set(
    globalEntries.map((e) => e.content.toLowerCase().trim().slice(0, 200))
  );

  const candidates = localEntries.filter((entry) => {
    const score = transferScore(entry);
    if (score < minScore) return false;

    const contentKey = entry.content.toLowerCase().trim().slice(0, 200);
    if (globalContentSet.has(contentKey)) return false;

    // Secret rows never auto-share regardless of score (shareMemory would throw); checked LAST so the stats counter only counts rows the veto actually withheld.
    if (detectSecret(entry).flagged) {
      if (options.stats) options.stats.secretSkipped++;
      return false;
    }

    return true;
  });

  if (dryRun) return candidates;

  const shared: MemoryEntry[] = [];
  for (const entry of candidates) {
    // skipEmbed: this is a batch producer, so it embeds once via embedAll() below rather than once per row inside shareMemory.
    const result = shareMemory(localRoot, entry.id, { force: true, skipEmbed: true });
    if (result) shared.push(result);
  }

  if (shared.length > 0) {
    void embedAll(globalRoot).catch(() => {});
  }

  return shared;
}

/** Copies global memories into the local store, skipping ones that already exist locally by ID; returns the count copied. */
export function syncGlobalToLocal(
  localRoot: string,
  globalRoot: string,
  opts: { includeCrossProject?: boolean } = {},
): number {
  if (!fs.existsSync(globalRoot)) return 0;

  // Host-wide read: copies the global union into a tenant-scoped local store; writeEntry carries the tenant from the local-root context.
  const globalEntries = loadAllEntries(globalRoot);
  const localIndex = loadIndex(localRoot);

  // Sync must not re-import what ambient context excludes: other-project rows skip by default, secret rows never copy; origin_project is preserved (writeEntry only stamps when missing).
  const currentName = deriveOriginProject(path.dirname(path.resolve(localRoot)));
  let count = 0;

  for (const entry of globalEntries) {
    if (localIndex.entries[entry.id]) continue;
    if (detectSecret(entry).flagged) continue;
    if (
      !opts.includeCrossProject &&
      classifyOriginProject(entry.origin_project, currentName) === 'cross-project'
    ) continue;

    writeEntry(localRoot, entry);
    count++;
  }

  // Batch producer: one embedAll() on the destination rather than embedMemory() per copied row (same invariant as autoShare).
  if (count > 0) {
    void embedAll(localRoot).catch(() => {});
  }

  return count;
}
