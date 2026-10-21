// contextGet's selection stages: the pinned-only branch, the strongest-first branch and the search branch.

import { recallScopeFilter } from '../base/scope/recall-scope.js';
import { calculateStrength, strengthOptionsOf, type MemoryEntry, type StrengthOptions } from '../base/memory/memory.js';
import { auditQueryFields } from '../base/records/audit-report.js';
import type { ContextReads, HippoStore } from '../store/port.js';
import { isWorthSurfacing } from '../base/memory/memory-quality.js';
import { rankBothStores } from '../domain/sharing/search-both.js';
import { evalNow } from '../base/memory/ablation.js';
import { searchByEngine } from '../domain/search/engine.js';
import { vectorSourceOf } from '../domain/search/hybrid.js';
import { infraOf } from './infra.js';
import type { HybridVectorCandidates, VectorSource } from '../domain/search/vector.js';
import { DEFAULT_LOCAL_BUMP, type SearchResult } from '../base/rank/search-types.js';
import { compareScoredResults } from '../base/rank/compare.js';
import { scopeMatch } from '../base/rank/active-scope.js';
import { scopeBoostFor } from '../domain/search/boosts.js';
import { type HippoConfig } from '../base/config/config.js';
import type { ProjectRef } from '../base/scope/project-identity.js';
import type { AmbientAdmission } from '../base/scope/read-admission.js';
import { promptTokens, contentTokens, gatePromptRecall } from '../base/rank/prompt-recall.js';
import type { DeliveryObserver } from './delivery-recorder.js';
import type { ContextCost, ContextOptions, ContextResultEntry } from './context-types.js';
import { heldIds } from './recall/finish.js';
import type { Context, GlobalInReach } from './types.js';
import type { AmbientLoadResult } from '../store/port/context-reads.js';
import type { AppendAuditOpts } from '../store/port/types.js';

import {
  admitWithinBudget,
  newestWorthSurfacing,
  promptRecallGateOf,
  reservePinned,
  strongestWithin,
  type Picked,
} from '../domain/context/select-policy.js';

const GLOBAL_DISCOUNT = 1 / DEFAULT_LOCAL_BUMP;

/** One store contextGet reads rows from: its base search and its context reads. */
export interface ContextSource {
  readonly store: HippoStore;
  readonly reads: ContextReads;
}

/** What contextGet resolved from opts and config before it read a row. */
export interface ContextPlan {
  /** The served store, else hippo.db under the root. */
  local: ContextSource;
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
  /** `admit` as data, for a store to apply. */
  rule: AmbientAdmission;
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
  strength: StrengthOptions,
): [MemoryEntry[], MemoryEntry[]] {
  const score = (e: MemoryEntry, isGlobal: boolean): number =>
    calculateStrength(e, now, strength) * (isGlobal ? GLOBAL_DISCOUNT : 1);
  const best = new Map<string, { entry: MemoryEntry; isGlobal: boolean }>();
  const offer = (entry: MemoryEntry, isGlobal: boolean): void => {
    const held = best.get(entry.content);
    const wins =
      !held ||
      (held.entry.pinned !== entry.pinned ? entry.pinned : score(entry, isGlobal) > score(held.entry, held.isGlobal));
    if (wins) best.set(entry.content, { entry, isGlobal });
  };
  for (const e of local) offer(e, false);
  for (const e of global) offer(e, true);
  const kept = new Set([...best.values()].map((b) => b.entry));
  return [local.filter((e) => kept.has(e)), global.filter((e) => kept.has(e))];
}

interface PromptCandidate {
  id: string;
  tokens: Set<string>;
  entry: MemoryEntry;
  isGlobal: boolean;
}

/**
 * Pins plus the prompt-recall or recent-N backfill; null means the hook block is turned off, so task state stays out
 * too.
 */
export function selectPinned(
  opts: ContextOptions,
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
  const [localPool, globalPool] = oneCopyPerMemory(
    localEntries,
    globalEntries,
    nowP,
    strengthOptionsOf(plan.config.runtime),
  );
  obs?.dropMissing([...localEntries, ...globalEntries], [...localPool, ...globalPool], 'load', 'duplicate');
  const picked: Picked<ContextResultEntry> = { items: [], ids: new Set<string>(), used: 0 };

  // Pinned entries are explicit intent, the recent-N list an automatic backfill; both share ONE budget and the recent
  // loop runs first, so pins are ranked here and reserve their share before it can spend.
  const pinnedLocal = localPool.filter((e) => e.pinned);
  const pinnedGlobal = globalPool.filter((e) => e.pinned);
  const rankedPinned = rankPinned(plan, pinnedLocal, pinnedGlobal, nowP);
  const recentBudget = Math.max(0, effBudget - reservePinned(rankedPinned, effBudget));

  // Prompt recall gates the backfill on the prompt instead of recency.
  if (plan.promptRecallPending) {
    const candidates = (): PromptCandidate[] =>
      promptRecallCandidates(plan, pools, admission.admit, rankedPinned, nowP);
    backfillFromPrompt(opts, plan, { pinnedCfg, candidates, picked, recentBudget });
  } else if (plan.includeRecent > 0) {
    backfillRecent(plan, { localPool, globalPool, picked, recentBudget, nowP });
  }

  admitWithinBudget(rankedPinned, picked, effBudget, rejectOverBudget(obs));
  return picked.items;
}

function rankPinned(
  plan: ContextPlan,
  pinnedLocal: MemoryEntry[],
  pinnedGlobal: MemoryEntry[],
  nowP: Date,
): ContextResultEntry[] {
  const strength = strengthOptionsOf(plan.config.runtime);
  return [
    ...pinnedLocal.map((e) => ({ entry: e, isGlobal: plan.primaryIsGlobal })),
    ...pinnedGlobal.map((e) => ({ entry: e, isGlobal: true })),
  ]
    .map(({ entry, isGlobal }) => {
      const scopeBoost = scopeBoostFor(scopeMatch(entry.tags, plan.activeScope));
      return {
        entry,
        score: calculateStrength(entry, nowP, strength) * (isGlobal ? GLOBAL_DISCOUNT : 1) * scopeBoost,
        tokens: plan.price(entry, isGlobal),
        isGlobal,
      };
    })
    .sort(compareScoredResults);
}

interface BackfillFromPromptOptions {
  readonly pinnedCfg: HippoConfig;
  readonly candidates: () => PromptCandidate[];
  readonly picked: Picked<ContextResultEntry>;
  readonly recentBudget: number;
}

function rejectOverBudget(obs: DeliveryObserver | undefined): ((row: ContextResultEntry) => void) | undefined {
  return obs && ((r) => obs.reject(r.entry, 'budget', 'budget', r.score, r.tokens));
}

function backfillFromPrompt(opts: ContextOptions, plan: ContextPlan, options: BackfillFromPromptOptions): void {
  const { pinnedCfg, candidates, picked, recentBudget } = options;
  const gate = promptRecallGateOf(pinnedCfg.pinnedInject);
  const p = promptTokens(opts.prompt ?? '');
  if (p.size === 0) return;
  const candidateItems = candidates();
  const gated = gatePromptRecall(p, candidateItems, gate);
  plan.obs?.gated(p, candidateItems, gate, gated);
  const rows = gated.map((g) => ({
    entry: g.item.entry,
    score: g.score,
    tokens: plan.price(g.item.entry, g.item.isGlobal, true),
    isGlobal: g.item.isGlobal,
    promptRecall: true,
  }));
  admitWithinBudget(rows, picked, recentBudget, rejectOverBudget(plan.obs));
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
    !admit(e)
      ? 'scope'
      : e.pinned
        ? 'pinned'
        : !isWorthSurfacing(e)
          ? 'quality'
          : pinnedText.has(e.content)
            ? 'duplicate'
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
  const strength = strengthOptionsOf(plan.config.runtime);
  const [localCandidates, globalCandidates] = oneCopyPerMemory(localEligible, globalEligible, nowP, strength);
  obs?.dropMissing(
    [...localEligible, ...globalEligible],
    [...localCandidates, ...globalCandidates],
    'eligible',
    'duplicate',
  );
  return promptCandidateItems(localCandidates, globalCandidates, primaryIsGlobal);
}

function promptCandidateItems(
  localCandidates: MemoryEntry[],
  globalCandidates: MemoryEntry[],
  primaryIsGlobal: boolean,
): PromptCandidate[] {
  const seenCandidateIds = new Set<string>();
  const candidateItems: PromptCandidate[] = [];
  // Local wins the id collision (a global row synced into the local store).
  for (const [entries, isGlobal] of [
    [localCandidates, primaryIsGlobal],
    [globalCandidates, true],
  ] as const) {
    for (const e of entries) {
      if (seenCandidateIds.has(e.id)) continue;
      seenCandidateIds.add(e.id);
      candidateItems.push({ id: e.id, tokens: contentTokens(e.content), entry: e, isGlobal });
    }
  }
  return candidateItems;
}

interface BackfillRecentOptions {
  readonly localPool: MemoryEntry[];
  readonly globalPool: MemoryEntry[];
  readonly picked: Picked<ContextResultEntry>;
  readonly recentBudget: number;
  readonly nowP: Date;
}

function backfillRecent(plan: ContextPlan, options: BackfillRecentOptions): void {
  const { localPool, globalPool, picked, recentBudget, nowP } = options;
  const strength = strengthOptionsOf(plan.config.runtime);
  const candidates = [
    ...localPool.map((entry) => ({ entry, isGlobal: plan.primaryIsGlobal })),
    ...globalPool.map((entry) => ({ entry, isGlobal: true })),
  ];
  const recent = newestWorthSurfacing(candidates, plan.includeRecent).map(({ entry, isGlobal }) => ({
    entry,
    score: calculateStrength(entry, nowP, strength) * (isGlobal ? GLOBAL_DISCOUNT : 1),
    tokens: plan.price(entry, isGlobal),
    isGlobal,
  }));
  admitWithinBudget(recent, picked, recentBudget, rejectOverBudget(plan.obs));
}

/** No query: the strongest memories by strength, up to budget. */
export function selectStrongest(plan: ContextPlan, left: number, pools: ContextPools): ContextResultEntry[] {
  const now = evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const strength = strengthOptionsOf(plan.config.runtime);
  const [localPool, globalPool] = oneCopyPerMemory(pools.local.entries, pools.global.entries, now, strength);
  const localRanked = localPool.map((e) => ({
    entry: e,
    score: calculateStrength(e, now, strength),
    tokens: plan.price(e, plan.primaryIsGlobal),
    isGlobal: plan.primaryIsGlobal,
  }));

  const globalRanked = globalPool.map((e) => ({
    entry: e,
    score: calculateStrength(e, now, strength) * GLOBAL_DISCOUNT,
    tokens: plan.price(e, true),
    isGlobal: true,
  }));

  return strongestWithin(localRanked, globalRanked, left);
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
  const results =
    plan.hasGlobal && !plan.primaryIsGlobal
      ? await searchBothStores(ctx, plan, { left, minResults, pools, admit: admission.bothStoresAdmit })
      : await searchLocalRows(ctx, plan, {
          left,
          minResults,
          localEntries: pools.local.entries,
          admit: admission.admit,
        });
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

async function searchBothStores(
  ctx: Context,
  plan: ContextPlan,
  options: SearchBothStoresOptions,
): Promise<ContextResultEntry[]> {
  const { left, minResults, pools, admit } = options;
  const { cost, price } = plan;
  // A local pool row is local by construction; sync keeps a global row's id on its local copy, so the global pool is
  // looked up.
  const poolIds = (pool: AmbientLoadResult): string[] => [...pool.entries, ...(pool.recall ?? [])].map((e) => e.id);
  const localIds = new Set(poolIds(pools.local));
  const alsoLocal = await heldIds(
    plan.local.store,
    poolIds(pools.global).filter((id) => !localIds.has(id)),
    ctx.tenantId,
  );
  const isGlobalHit = (e: MemoryEntry): boolean => !localIds.has(e.id) && !alsoLocal.has(e.id);
  const sources = {
    local: vectorSourceOf({
      store: plan.local.store,
      config: plan.config,
      onHippoDb: ctx.reach?.isHippoDb,
      embedderFor: infraOf(ctx).embedderFor,
    }),
    // Its own config.json names the global store's embedding model, read only when the vector arm runs.
    global: globalVectorSource(ctx),
  };
  const merged = await rankBothStores(
    plan.query,
    sources,
    { local: pools.local.entries, global: pools.global.entries },
    contextVectorSpec(ctx, plan, admit),
    {
      budget: left,
      minResults,
      cost: cost && ((r) => price(r.entry, isGlobalHit(r.entry))),
      scope: plan.activeScope,
      runtime: ctx.config.runtime,
    },
  );
  return merged.map((r) => ({
    entry: r.entry,
    score: r.score,
    tokens: price(r.entry, isGlobalHit(r.entry)),
    isGlobal: isGlobalHit(r.entry),
  }));
}

/** The vector arm under the lexical window's own tenant, scope and current-row rules. */
function contextVectorSpec(
  ctx: Context,
  plan: ContextPlan,
  admit: (e: MemoryEntry) => boolean,
): HybridVectorCandidates {
  return {
    tenantId: ctx.tenantId,
    scope: recallScopeFilter(plan.exactScope, 'exact', plan.ownScope),
    includeSuperseded: false,
    admit,
  };
}

interface SearchLocalRowsOptions {
  readonly left: number;
  readonly minResults: number | undefined;
  readonly localEntries: MemoryEntry[];
  readonly admit: (e: MemoryEntry) => boolean;
}

async function searchLocalRows(
  ctx: Context,
  plan: ContextPlan,
  options: SearchLocalRowsOptions,
): Promise<ContextResultEntry[]> {
  const { left, minResults, localEntries, admit } = options;
  const { cost, price, primaryIsGlobal, query, config: ctxConfig } = plan;
  const usePhysicsCtx = ctxConfig.physics?.enabled !== false;
  const localCost = cost && ((r: SearchResult) => price(r.entry, primaryIsGlobal));
  const vectorCandidates = contextVectorSpec(ctx, plan, admit);
  const store = plan.local.store;
  const ctxResults = await searchByEngine(
    vectorSourceOf({
      store,
      config: ctxConfig,
      onHippoDb: ctx.reach?.isHippoDb,
      embedderFor: infraOf(ctx).embedderFor,
    }),
    query,
    localEntries,
    usePhysicsCtx ? ctxConfig.physics : null,
    {
      budget: left,
      minResults,
      cost: localCost,
      scope: plan.activeScope,
      runtime: ctx.config.runtime,
      vectorCandidates,
    },
  );
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
  if (plan.hasLocal) await plan.local.store.appendAuditEvents([row]);
  if (plan.hasGlobal && !plan.primaryIsGlobal) await globalStoreInReach(ctx).appendAuditEvents([row]);
}

/** The operator's global store, which planContext proved present before it set hasGlobal. */
export function globalStoreInReach(ctx: Context): HippoStore {
  return globalInReach(ctx).store;
}

function globalInReach(ctx: Context): GlobalInReach {
  const global = ctx.reach?.global;
  if (global === undefined) throw new Error('hasGlobal without a global store in reach');
  return global;
}

/** The global store's vectors, embedded by the model its own config.json names. */
function globalVectorSource(ctx: Context): VectorSource {
  const { store, config } = globalInReach(ctx);
  return vectorSourceOf({ store, config, onHippoDb: true, embedderFor: infraOf(ctx).embedderFor });
}
