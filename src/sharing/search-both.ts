// Search across the local and global stores, merged into one ranked, budgeted list.

import { compareScoresDesc } from '../core/compare.js';
import * as fs from 'fs';
import { MemoryEntry } from '../core/memory.js';
import { loadSearchEntries, loadRecallSearchEntries, recallScopeFilter } from '../store/search-rows.js';
import { passesScopeFilterForRecall, passesCliRecallScopeFilter } from '../store/recall-scope.js';
import { search } from '../search/bm25-search.js';
import { hybridSearch } from '../search/hybrid.js';
import { fitBudget } from '../search/finalize.js';
import { DEFAULT_LOCAL_BUMP, DEFAULT_RECALL_BUDGET, type SearchResult, type ResultCost } from '../core/search-types.js';
import type { HybridVectorCandidates } from '../search/vector.js';
import { evalNow } from '../core/ablation.js';
import { duplicateKey } from '../util/same-text.js';
import { errorMessage, log } from '../util/log.js';

// The rows are already copied; a failed background embed only delays vectors, so it warns instead of throwing.
export function logEmbedAllFailure<E>(caller: string, err: E): void {
  log.warn(`${caller}: background embed failed (${errorMessage(err)}); run 'hippo embed' to backfill`);
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
  const { budget = DEFAULT_RECALL_BUDGET, now = evalNow(), minResults, tenantId } = options;
  const effectiveMin = minResults ?? 1;

  const localEntries = fs.existsSync(localRoot) ? loadSearchEntries(localRoot, query, undefined, tenantId) : [];
  const globalEntries = fs.existsSync(globalRoot) ? loadSearchEntries(globalRoot, query, undefined, tenantId) : [];

  if (localEntries.length === 0 && globalEntries.length === 0) return [];

  // Search each store with full budget, then blend
  const localResults = search(query, localEntries, { budget, now, minResults });
  const globalResults = search(query, globalEntries, { budget, now, minResults });

  const deduped = dedupeByContent(tagLocalAndGlobal(localResults, globalResults));

  // PLAIN stable score sort on purpose: both inputs are deterministically ordered,
  // and an exact tie keeps the LOCAL result ahead of the global one (concat order).
  deduped.sort((a, b) => compareScoresDesc(a.score, b.score));

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

function tagLocalAndGlobal(localResults: SearchResult[], globalResults: SearchResult[]): Array<SearchResult & { isGlobal: boolean }> {
  // Tag global results. Local memories get a configurable priority bump.
  return [
    ...localResults.map((r) => ({
      ...r,
      isGlobal: false,
      score: r.score * DEFAULT_LOCAL_BUMP,
      breakdown: r.breakdown
        ? { ...r.breakdown, sourceBump: DEFAULT_LOCAL_BUMP, final: r.breakdown.final * DEFAULT_LOCAL_BUMP }
        : undefined,
    })),
    ...globalResults.map((r) => ({ ...r, isGlobal: true })),
  ];
}

function dedupeByContent<T extends SearchResult>(tagged: T[]): T[] {
  // Remove duplicates by content (local/global IDs differ after promote/share)
  const seen = new Set<string>();
  return tagged.filter((r) => {
    const key = duplicateKey(r.entry.content);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  /** Budget cost per result, spent the same way in each store and in the merged list. */
  cost?: ResultCost;
  /** Propagated to underlying hybridSearch calls.
   *  Per-call > env HIPPO_SUMMARY_DEBOOST > 0.85 default. */
  summaryDeboost?: number;
  /** Propagated. Default true (1.05 boost if rebuilt within 7d). */
  summaryFreshness?: boolean;
  /** v39 memory scope isolation: optional admission predicate applied to the
   *  loaded candidate entries of BOTH stores BEFORE ranking, cross-store
   *  content-dedupe, and budgeting. Without it, an excluded row can shadow
   *  its admitted duplicate in the dedupe pass, or saturate the budget.
   *  Default undefined = unchanged behavior (recall paths never set it). */
  entryFilter?: (entry: MemoryEntry) => boolean;
  /** Recall-mode scope filter, consumed by `searchBothHybrid` only.
   *  ABSENT (undefined) is the only unfiltered mode: both stores load via
   *  `loadSearchEntries` unchanged (background pipelines / eval callers).
   *  PRESENT switches the internal loads to `loadRecallSearchEntries` (SQL
   *  scope predicate) plus the recall-scope JS post-filter:
   *    `{}`                                  = default-deny (`unknown:legacy`
   *                                            + `<source>:private:*` excluded)
   *    `{ requested: 'X' }`                  = exact match on scope X
   *                                            (api.recall semantics)
   *    `{ requested: 'X', additive: true }`  = default-admitted set PLUS
   *                                            scope X (CLI --scope
   *                                            semantics; see recall-scope.ts
   *                                            passesCliRecallScopeFilter)
   *  Object form on purpose — the sibling `scope` option above already gives
   *  `null` a different meaning (boost-neutral), so a flat `string | null`
   *  here would overload null with contradictory semantics. Do NOT pass an
   *  empty object casually from non-recall paths. */
  recallScope?: { requested?: string; additive?: boolean; ownScope?: string };
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
  const { includeSuperseded, asOf, tenantId, entryFilter, recallScope } = options;

  // When an admission filter is active, lift the per-store candidate cap
  // (default 200): excluded rows matching the query could otherwise fill the
  // window before any admitted row is even loaded. 5000 is bounded so a common
  // term on a large store cannot stall an interactive call by ranking every match.
  const searchWindow = entryFilter ? 5000 : undefined;
  // Recall mode: push the scope predicate into SQL exactly like
  // api.recall (loadRecallSearchEntries), so quarantine/private rows never
  // enter the candidate set, never shadow admitted duplicates in the dedupe
  // pass, and never consume budget. The JS post-filter below is the
  // regex-only `<source>:private:*` half plus defense-in-depth on exact
  // match, mirroring api.ts's recall load.
  const loadEntries = (root: string): MemoryEntry[] => {
    if (!fs.existsSync(root)) return [];
    return recallScope
      ? loadRecallSearchEntries(
          root, query, searchWindow, tenantId, recallScope.requested,
          recallScope.additive ? 'additive' : 'exact',
          Boolean(includeSuperseded) || Boolean(asOf),
          undefined,
          recallScope.ownScope,
        )
      : loadSearchEntries(root, query, searchWindow, tenantId);
  };
  const passesScope = (e: MemoryEntry): boolean =>
    !recallScope || (recallScope.additive
      ? passesCliRecallScopeFilter(e.scope ?? null, recallScope.requested) || passesScopeFilterForRecall(e.scope ?? null, undefined, recallScope.ownScope)
      : passesScopeFilterForRecall(e.scope ?? null, recallScope.requested, recallScope.ownScope));
  const admit = (e: MemoryEntry): boolean => passesScope(e) && (!entryFilter || entryFilter(e));
  const localEntries = loadEntries(localRoot).filter(admit);
  const globalEntries = loadEntries(globalRoot).filter(admit);

  // The vector arm loads under the same SQL rules as loadEntries, then the same JS admission.
  const vectorCandidates = {
    tenantId,
    scope: recallScope ? recallScopeFilter(recallScope.requested, recallScope.additive ? 'additive' : 'exact', recallScope.ownScope) : undefined,
    includeSuperseded: !recallScope || Boolean(includeSuperseded) || Boolean(asOf),
    admit,
  };
  return rankBothStores(query, { local: localRoot, global: globalRoot }, { local: localEntries, global: globalEntries }, vectorCandidates, options);
}

/** Hybrid ranking of rows already loaded from each store: the local bump, one copy per text, then the shared budget. */
export async function rankBothStores(
  query: string,
  roots: { local: string; global: string },
  entries: { local: MemoryEntry[]; global: MemoryEntry[] },
  vectorCandidates: HybridVectorCandidates,
  options: HybridSearchOptions = {},
): Promise<SearchResult[]> {
  const {
    budget = DEFAULT_RECALL_BUDGET, now = evalNow(), embeddingWeight, explain, mmr, mmrLambda, localBump = DEFAULT_LOCAL_BUMP, minResults, cost, scope,
    includeSuperseded, asOf, summaryDeboost, summaryFreshness
  } = options;
  if (entries.local.length === 0 && entries.global.length === 0) return [];
  const shared = {
    budget, now, embeddingWeight, explain, mmr, mmrLambda, minResults, cost, scope, includeSuperseded, asOf, summaryDeboost, summaryFreshness,
    vectorCandidates
  };
  const localResults = await hybridSearch(query, entries.local, { ...shared, hippoRoot: roots.local });
  const globalResults = await hybridSearch(query, entries.global, { ...shared, hippoRoot: roots.global });

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
    const key = duplicateKey(r.entry.content);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // PLAIN stable score sort on purpose -- see searchBoth above;
  // same rationale (deterministic inputs + stability; local-first on ties).
  deduped.sort((a, b) => compareScoresDesc(a.score, b.score));

  return fitBudget(deduped, budget, minResults ?? 1, cost);
}
