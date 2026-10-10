// getContext's selection stages: the pinned-only branch, the strongest-first branch and the search branch.

import { recallScopeFilter } from '../store/search-rows.js';
import type { AmbientLoadResult } from '../store/candidates.js';
import { heldIdLookup } from '../store/entry-reads.js';
import { calculateStrength, type MemoryEntry } from '../core/memory.js';
import { auditQueryFields, recordAuditEvent, type AppendAuditOpts } from '../store/audit.js';
import type { ContextReads, HippoStore } from '../store/index.js';
import { isWorthSurfacing } from '../core/memory-quality.js';
import { rankBothStores } from '../sharing/search-both.js';
import { evalNow } from '../core/ablation.js';
import { hybridSearch } from '../search/hybrid.js';
import { physicsSearch } from '../search/physics-search.js';
import type { HybridVectorCandidates } from '../search/vector.js';
import { DEFAULT_LOCAL_BUMP, type SearchResult } from '../core/search-types.js';
import { compareScoredResults } from '../core/compare.js';
import { scopeMatch } from '../sharing/scope.js';
import { scopeBoostFor } from '../search/boosts.js';
import { type HippoConfig } from '../core/config.js';
import type { ProjectRef } from '../core/project-identity.js';
import {
  promptTokens,
  contentTokens,
  gatePromptRecall,
  type PromptRecallMetric,
  type PromptRecallGate,
} from '../core/prompt-recall.js';
import type { DeliveryObserver } from '../store/delivery-recorder.js';
import type { ContextCost, ContextOpts, ContextResultEntry } from './context-types.js';
import type { Context } from './types.js';

const GLOBAL_DISCOUNT = 1 / DEFAULT_LOCAL_BUMP;

/** One store getContext reads rows from: its base search and its context reads. */
export interface ContextSource {
  readonly store: HippoStore;
  readonly reads: ContextReads;
}

/** What getContext resolved from opts and config before it read a row. */
export interface ContextPlan {
  /** The served store, else hippo.db under the root. */
  local: ContextSource;
  /** The served store when it is not hippo.db; then every read and write goes through it and no hippo.db opens. */
  other: HippoStore | undefined;
  pinnedOnly: boolean;
  limit: number;
  includeRecent: number;
  activeScope: string;
  exactScope: string | undefined;
  /** The caller's personal scope, from its authenticated owner; the default deny admits it. */
  ownScope: string | undefined;
  query: string;
  hasLocal: boolean;
  hasGlobal: boolean;
  globalRoot: string;
  primaryIsGlobal: boolean;
  hasLocalTaskState: boolean;
  sharedStore: boolean;
  config: HippoConfig;
  currentProject: ProjectRef;
  includeCrossProject: boolean;
  originProject: readonly string[] | undefined;
  promptRecallPending: boolean;
  cost: ContextCost | undefined;
  price: (entry: MemoryEntry, isGlobal: boolean, promptRecall?: boolean) => number;
  obs: DeliveryObserver | undefined;
}

/** The ambient admit rules. */
export interface ContextAdmission {
  ambientAdmit: (e: MemoryEntry) => boolean;
  admit: (e: MemoryEntry) => boolean;
  /** What the two-store search admits: `admit` without the own-session compaction rule. */
  bothStoresAdmit: (e: MemoryEntry) => boolean;
}

export interface ContextPools {
  local: AmbientLoadResult;
  global: AmbientLoadResult;
}

// Share and promote copy a memory to the global store under a new id, so equal content is the only link.
// A pinned copy wins, then the stronger one after the ranking's own global discount; a tie keeps the local copy.
export function oneCopyPerMemory(
  local: readonly MemoryEntry[],
  global: readonly MemoryEntry[],
  now: Date,
): [MemoryEntry[], MemoryEntry[]] {
  const score = (e: MemoryEntry, isGlobal: boolean): number => calculateStrength(e, now) * (isGlobal ? GLOBAL_DISCOUNT : 1);
  const best = new Map<string, { entry: MemoryEntry; isGlobal: boolean }>();
  const offer = (entry: MemoryEntry, isGlobal: boolean): void => {
    const held = best.get(entry.content);
    const wins = !held || (held.entry.pinned !== entry.pinned
      ? entry.pinned
      : score(entry, isGlobal) > score(held.entry, held.isGlobal));
    if (wins) best.set(entry.content, { entry, isGlobal });
  };
  for (const e of local) offer(e, false);
  for (const e of global) offer(e, true);
  const kept = new Set([...best.values()].map((b) => b.entry));
  return [local.filter((e) => kept.has(e)), global.filter((e) => kept.has(e))];
}

export const finiteOr = (v: number, dflt: number, min: number): number =>
  Number.isFinite(v) && v >= min ? v : dflt;

/** The pinned-only branch's shared budget: the backfill and the pin loop both spend it. */
interface Picked {
  items: ContextResultEntry[];
  ids: Set<string>;
  used: number;
}

interface PromptCandidate {
  id: string;
  tokens: Set<string>;
  entry: MemoryEntry;
  isGlobal: boolean;
}

/** Pins plus the prompt-recall or recent-N backfill; null means the hook block is turned off, so task state stays out too. */
export function selectPinned(
  opts: ContextOpts,
  plan: ContextPlan,
  left: number,
  pools: ContextPools,
  admission: ContextAdmission,
): ContextResultEntry[] | null {
  const { obs, primaryIsGlobal, config: pinnedCfg } = plan;
  if (!pinnedCfg.pinnedInject.enabled) {
    return null;
  }
  // Effective budget: explicit opts.budget wins over config, less what the sections took.
  const effBudget = left;
  const nowP = evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const localEntries = pools.local.entries;
  const globalEntries = pools.global.entries;
  obs?.offer(localEntries, primaryIsGlobal);
  obs?.offer(globalEntries, true);
  const [localPool, globalPool] = oneCopyPerMemory(localEntries, globalEntries, nowP);
  obs?.dropMissing([...localEntries, ...globalEntries], [...localPool, ...globalPool], 'load', 'duplicate');
  const picked: Picked = { items: [], ids: new Set<string>(), used: 0 };

  // Pinned entries are explicit intent, the recent-N list an automatic backfill; both share ONE budget and the recent loop runs first,
  // so pins are ranked here and reserve their share before it can spend.
  const pinnedLocal = localPool.filter((e) => e.pinned);
  const pinnedGlobal = globalPool.filter((e) => e.pinned);
  const rankedPinned = rankPinned(plan, pinnedLocal, pinnedGlobal, nowP);
  const recentBudget = Math.max(0, effBudget - reservePinned(rankedPinned, effBudget));

  // Prompt recall gates the backfill on the prompt instead of recency.
  if (plan.promptRecallPending) {
    const candidates = (): PromptCandidate[] => promptRecallCandidates(plan, pools, admission.admit, rankedPinned, nowP);
    backfillFromPrompt(opts, plan, { pinnedCfg, candidates, picked, recentBudget });
  } else if (plan.includeRecent > 0) {
    backfillRecent(plan, { localPool, globalPool, picked, recentBudget, nowP });
  }

  admitWithinBudget(rankedPinned, picked, effBudget, obs);
  return picked.items;
}

function rankPinned(
  plan: ContextPlan,
  pinnedLocal: MemoryEntry[],
  pinnedGlobal: MemoryEntry[],
  nowP: Date,
): ContextResultEntry[] {
  return [
    ...pinnedLocal.map((e) => ({ entry: e, isGlobal: plan.primaryIsGlobal })),
    ...pinnedGlobal.map((e) => ({ entry: e, isGlobal: true })),
  ]
    .map(({ entry, isGlobal }) => {
      const scopeBoost = scopeBoostFor(scopeMatch(entry.tags, plan.activeScope));
      return {
        entry,
        score: calculateStrength(entry, nowP) * (isGlobal ? GLOBAL_DISCOUNT : 1) * scopeBoost,
        tokens: plan.price(entry, isGlobal),
        isGlobal,
      };
    })
    .sort(compareScoredResults);
}

// Mirrors the pin loop's continue-not-break so a big pin cannot block smaller ones from reserving, and dedupes by id
// because a synced pin sits in both stores. A pin also in the recent slice is counted twice: recents under-fill, safely.
function reservePinned(rankedPinned: ContextResultEntry[], effBudget: number): number {
  let pinnedReserve = 0;
  const reservedIds = new Set<string>();
  for (const r of rankedPinned) {
    if (reservedIds.has(r.entry.id)) continue;
    if (pinnedReserve + r.tokens <= effBudget) {
      pinnedReserve += r.tokens;
      reservedIds.add(r.entry.id);
    }
  }
  return pinnedReserve;
}

/** Skips ids already picked and rows past the budget, so a large row never blocks smaller ones behind it. */
function admitWithinBudget(
  rows: ContextResultEntry[],
  picked: Picked,
  budget: number,
  obs: DeliveryObserver | undefined,
): void {
  for (const r of rows) {
    if (picked.ids.has(r.entry.id)) continue;
    if (picked.used + r.tokens > budget) {
      obs?.reject(r.entry, 'budget', 'budget', r.score, r.tokens);
      continue;
    }
    picked.items.push(r);
    picked.ids.add(r.entry.id);
    picked.used += r.tokens;
  }
}

interface BackfillFromPromptOptions {
  readonly pinnedCfg: HippoConfig;
  readonly candidates: () => PromptCandidate[];
  readonly picked: Picked;
  readonly recentBudget: number;
}

// Overlap a candidate needs with the prompt when the config sets none.
const DEFAULT_PROMPT_RECALL_THRESHOLD = 0.04;

function backfillFromPrompt(opts: ContextOpts, plan: ContextPlan, options: BackfillFromPromptOptions): void {
  const { pinnedCfg, candidates, picked, recentBudget } = options;
  const rawMetric = pinnedCfg.pinnedInject.promptRecallMetric;
  const metric: PromptRecallMetric = rawMetric === 'cosine' ? 'cosine' : 'jaccard';
  const gate: PromptRecallGate = {
    metric,
    threshold: finiteOr(pinnedCfg.pinnedInject.promptRecallThreshold, DEFAULT_PROMPT_RECALL_THRESHOLD, 0),
    minShared: finiteOr(pinnedCfg.pinnedInject.promptRecallMinShared, 2, 0),
    maxItems: finiteOr(pinnedCfg.pinnedInject.promptRecallMaxItems, 5, 1),
  };
  const p = promptTokens(opts.prompt ?? '');
  if (p.size === 0) return;
  const candidateItems = candidates();
  const gated = gatePromptRecall(p, candidateItems, gate);
  plan.obs?.gated(p, candidateItems, gate, gated);
  for (const g of gated) {
    if (picked.ids.has(g.item.id)) continue;
    const tokens = plan.price(g.item.entry, g.item.isGlobal, true);
    if (picked.used + tokens > recentBudget) {
      plan.obs?.reject(g.item.entry, 'budget', 'budget', g.score, tokens);
      continue;
    }
    picked.items.push({ entry: g.item.entry, score: g.score, tokens, isGlobal: g.item.isGlobal, promptRecall: true });
    picked.ids.add(g.item.id);
    picked.used += tokens;
  }
}

// Candidates came off the ambient load's own connection (the recall request), not a fresh open.
function promptRecallCandidates(
  plan: ContextPlan,
  pools: ContextPools,
  admit: (e: MemoryEntry) => boolean,
  rankedPinned: ContextResultEntry[],
  nowP: Date,
): PromptCandidate[] {
  const { obs, primaryIsGlobal } = plan;
  // A candidate carrying a pin's text would inject that memory a second time.
  const pinnedText = new Set(rankedPinned.map((r) => r.entry.content));
  const ineligibleReason = (e: MemoryEntry): 'scope' | 'pinned' | 'quality' | 'duplicate' | null =>
    !admit(e) ? 'scope'
      : e.pinned ? 'pinned'
        : !isWorthSurfacing(e) ? 'quality'
          : pinnedText.has(e.content) ? 'duplicate'
            : null;
  const eligible = (e: MemoryEntry): boolean => {
    const why = ineligibleReason(e);
    if (why !== null && why !== 'pinned') obs?.reject(e, 'eligible', why);
    return why === null;
  };
  obs?.offer(pools.local.recall ?? [], primaryIsGlobal, 'prompt-recall');
  obs?.offer(pools.global.recall ?? [], true, 'prompt-recall');
  const localEligible = (pools.local.recall ?? []).filter(eligible);
  const globalEligible = (pools.global.recall ?? []).filter(eligible);
  const [localCandidates, globalCandidates] = oneCopyPerMemory(localEligible, globalEligible, nowP);
  obs?.dropMissing([...localEligible, ...globalEligible], [...localCandidates, ...globalCandidates], 'eligible', 'duplicate');
  const seenCandidateIds = new Set<string>();
  const candidateItems: PromptCandidate[] = [];
  // Local wins the id collision (a global row synced into the local store).
  for (const e of localCandidates) {
    if (seenCandidateIds.has(e.id)) continue;
    seenCandidateIds.add(e.id);
    candidateItems.push({ id: e.id, tokens: contentTokens(e.content), entry: e, isGlobal: primaryIsGlobal });
  }
  for (const e of globalCandidates) {
    if (seenCandidateIds.has(e.id)) continue;
    seenCandidateIds.add(e.id);
    candidateItems.push({ id: e.id, tokens: contentTokens(e.content), entry: e, isGlobal: true });
  }
  return candidateItems;
}

interface BackfillRecentOptions {
  readonly localPool: MemoryEntry[];
  readonly globalPool: MemoryEntry[];
  readonly picked: Picked;
  readonly recentBudget: number;
  readonly nowP: Date;
}

function backfillRecent(plan: ContextPlan, options: BackfillRecentOptions): void {
  const { localPool, globalPool, picked, recentBudget, nowP } = options;
  const recent = [
    ...localPool.map((entry) => ({ entry, isGlobal: plan.primaryIsGlobal })),
    ...globalPool.map((entry) => ({ entry, isGlobal: true })),
  ]
    // Newest first, then id: stable within one store, but same-millisecond rows fall to random ids across ingests.
    .sort((a, b) => {
      const byCreated = Date.parse(b.entry.created) - Date.parse(a.entry.created);
      return byCreated !== 0 ? byCreated : b.entry.id.localeCompare(a.entry.id);
    })
    // Filter before slice so a junk row is backfilled past, not counted against N. Pins bypass the floor: a dropped
    // pin's share of the shared budget would go to a backfilled row, and the pin loop could not win it back.
    .filter(({ entry }) => entry.pinned || isWorthSurfacing(entry))
    .slice(0, plan.includeRecent)
    .map(({ entry, isGlobal }) => ({
      entry,
      score: calculateStrength(entry, nowP) * (isGlobal ? GLOBAL_DISCOUNT : 1),
      tokens: plan.price(entry, isGlobal),
      isGlobal,
    }));
  admitWithinBudget(recent, picked, recentBudget, plan.obs);
}

/** No query: the strongest memories by strength, up to budget. */
export function selectStrongest(plan: ContextPlan, left: number, pools: ContextPools): ContextResultEntry[] {
  const now = evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const [localPool, globalPool] = oneCopyPerMemory(pools.local.entries, pools.global.entries, now);
  const localRanked = localPool
    .map((e) => ({
      entry: e,
      score: calculateStrength(e, now),
      tokens: plan.price(e, plan.primaryIsGlobal),
      isGlobal: plan.primaryIsGlobal,
    }))
    .sort(compareScoredResults);

  const globalRanked = globalPool
    .map((e) => ({
      entry: e,
      score: calculateStrength(e, now) * GLOBAL_DISCOUNT,
      tokens: plan.price(e, true),
      isGlobal: true,
    }))
    .sort(compareScoredResults);

  const combined = [...localRanked, ...globalRanked].sort(compareScoredResults);

  const selected: ContextResultEntry[] = [];
  let used = 0;
  for (const r of combined) {
    if (used + r.tokens > left) continue;
    selected.push(r);
    used += r.tokens;
  }
  return selected;
}

/** Real query: hybrid search over both stores, or physics/hybrid over the local rows; emits the 'recall' audit row. */
export async function selectBySearch(
  ctx: Context,
  plan: ContextPlan,
  left: number,
  pools: ContextPools,
  admission: ContextAdmission,
): Promise<ContextResultEntry[]> {
  const minResults = plan.cost ? 0 : undefined; // a priced block skips an oversize top hit too, so the budget bounds it
  const results = plan.hasGlobal && !plan.primaryIsGlobal
    ? await searchBothStores(ctx, plan, { left, minResults, pools, admit: admission.bothStoresAdmit })
    : await searchLocalRows(ctx, plan, { left, minResults, localEntries: pools.local.entries, admit: admission.admit });
  await auditContextRecall(ctx, plan, results.length);
  return results;
}

// The pools were admitted at load, before ranking, dedupe and budget: a post-filter would let an excluded row fill the
// budget or shadow its admitted duplicate.
interface SearchBothStoresOptions {
  readonly left: number;
  readonly minResults: number | undefined;
  readonly pools: ContextPools;
  readonly admit: (e: MemoryEntry) => boolean;
}

async function searchBothStores(ctx: Context, plan: ContextPlan, options: SearchBothStoresOptions): Promise<ContextResultEntry[]> {
  const { left, minResults, pools, admit } = options;
  const { cost, price } = plan;
  // A local pool row is local by construction; sync keeps a global row's id on its local copy, so the global pool is looked up.
  const poolIds = (pool: AmbientLoadResult): string[] => [...pool.entries, ...(pool.recall ?? [])].map((e) => e.id);
  const localIds = new Set(poolIds(pools.local));
  const alsoLocal = heldIdLookup(ctx.hippoRoot, ctx.tenantId, poolIds(pools.global).filter((id) => !localIds.has(id)));
  const isGlobalHit = (e: MemoryEntry): boolean => !localIds.has(e.id) && !alsoLocal(e.id);
  const roots = { local: ctx.hippoRoot, global: plan.globalRoot };
  const merged = await rankBothStores(plan.query, roots, { local: pools.local.entries, global: pools.global.entries }, contextVectorSpec(ctx, plan, admit), {
    budget: left,
    minResults,
    cost: cost && ((r) => price(r.entry, isGlobalHit(r.entry))),
    scope: plan.activeScope,
  });
  return merged.map((r) => ({
    entry: r.entry,
    score: r.score,
    tokens: price(r.entry, isGlobalHit(r.entry)),
    isGlobal: isGlobalHit(r.entry),
  }));
}

/** The vector arm under the lexical window's own tenant, scope and current-row rules. */
function contextVectorSpec(ctx: Context, plan: ContextPlan, admit: (e: MemoryEntry) => boolean): HybridVectorCandidates {
  return { tenantId: ctx.tenantId, scope: recallScopeFilter(plan.exactScope, 'exact', plan.ownScope), includeSuperseded: false, admit };
}

interface SearchLocalRowsOptions {
  readonly left: number;
  readonly minResults: number | undefined;
  readonly localEntries: MemoryEntry[];
  readonly admit: (e: MemoryEntry) => boolean;
}

async function searchLocalRows(ctx: Context, plan: ContextPlan, options: SearchLocalRowsOptions): Promise<ContextResultEntry[]> {
  const { left, minResults, localEntries, admit } = options;
  const { cost, price, primaryIsGlobal, query, config: ctxConfig } = plan;
  const usePhysicsCtx = ctxConfig.physics?.enabled !== false;
  const localCost = cost && ((r: SearchResult) => price(r.entry, primaryIsGlobal));
  const vectorCandidates = contextVectorSpec(ctx, plan, admit);
  const store = plan.local.store;
  const ctxResults = usePhysicsCtx
    ? await physicsSearch(query, localEntries, {
        budget: left,
        minResults,
        cost: localCost,
        hippoRoot: ctx.hippoRoot,
        physicsConfig: ctxConfig.physics,
        scope: plan.activeScope,
        vectorCandidates,
        store,
      })
    : await hybridSearch(query, localEntries, {
        budget: left,
        minResults,
        cost: localCost,
        hippoRoot: ctx.hippoRoot,
        scope: plan.activeScope,
        vectorCandidates,
        store,
      });
  return ctxResults.map((r) => ({
    entry: r.entry,
    score: r.score,
    tokens: price(r.entry, primaryIsGlobal),
    isGlobal: primaryIsGlobal,
  }));
}

// Same 'recall' op api.recall emits; the pinned-only and no-query branches never search, so they never emit.
async function auditContextRecall(ctx: Context, plan: ContextPlan, resultCount: number): Promise<void> {
  const row: AppendAuditOpts = {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    op: 'recall',
    metadata: { ...auditQueryFields(plan.query), results: resultCount, mode: 'context' },
  };
  if (plan.other) {
    await plan.other.appendAuditEvents([row]);
    return;
  }
  if (plan.hasLocal) recordAuditEvent(ctx.hippoRoot, row);
  if (plan.hasGlobal && !plan.primaryIsGlobal) recordAuditEvent(plan.globalRoot, row);
}
