// contextGet's selection stages: the pinned-only branch and the strongest-first branch.
import { calculateStrengthAt, type StrengthModel } from '../../base/memory/strength.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { isWorthSurfacing } from '../../base/memory/memory-quality.js';
import { DEFAULT_LOCAL_BUMP } from '../../base/rank/search-types.js';
import { compareScoredResults } from '../../base/rank/compare.js';
import { scopeMatch } from '../../base/rank/active-scope.js';
import { scopeBoostFor } from '../../domain/search/boosts.js';
import type { HippoConfig } from '../../base/config/config.js';
import { promptTokens, contentTokens, gatePromptRecall } from '../../base/rank/prompt-recall.js';
import type { DeliveryObserver } from '../delivery/delivery-recorder.js';
import type { ContextOptions, ContextResultEntry } from './context-types.js';
import {
  admitWithinBudget,
  newestWorthSurfacing,
  promptRecallGateOf,
  reservePinned,
  strongestWithin,
  type Picked,
} from '../../domain/context/select-policy.js';
import type { ContextPlan } from './context-plan.js';
import type { ContextAdmission, ContextPools } from './context-pools.js';

const GLOBAL_DISCOUNT = 1 / DEFAULT_LOCAL_BUMP;

// Share and promote copy a memory to the global store under a new id, so equal content is the only
// link. A pinned copy wins, then the stronger one after the ranking's own global discount; a tie
// keeps the local copy.
export function oneCopyPerMemory(
  local: readonly MemoryEntry[],
  global: readonly MemoryEntry[],
  now: Date,
  strength: StrengthModel,
): [MemoryEntry[], MemoryEntry[]] {
  const score = (e: MemoryEntry, isGlobal: boolean): number =>
    calculateStrengthAt(e, now, strength) * (isGlobal ? GLOBAL_DISCOUNT : 1);
  const best = new Map<string, { entry: MemoryEntry; isGlobal: boolean }>();
  const offer = (entry: MemoryEntry, isGlobal: boolean): void => {
    const held = best.get(entry.content);
    const wins =
      !held ||
      (held.entry.pinned !== entry.pinned
        ? entry.pinned
        : score(entry, isGlobal) > score(held.entry, held.isGlobal));
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

export interface SelectPinnedOptions {
  readonly opts: ContextOptions;
  readonly plan: ContextPlan;
  readonly left: number;
  readonly pools: ContextPools;
  readonly admission: ContextAdmission;
}

/**
 * Pins plus the prompt-recall or recent-N backfill; null means the hook block is turned off, so
 * task state stays out too.
 */
export function selectPinned({
  opts,
  plan,
  left,
  pools,
  admission,
}: SelectPinnedOptions): ContextResultEntry[] | null {
  const { obs, config: pinnedCfg } = plan;
  if (!pinnedCfg.pinnedInject.enabled) {
    return null;
  }
  // Effective budget: explicit opts.budget wins over config, less what the sections took.
  const effBudget = left;
  const nowP = plan.now;
  const [localPool, globalPool] = loadedOneCopy(plan, pools);
  const picked: Picked<ContextResultEntry> = { items: [], ids: new Set<string>(), used: 0 };

  // Pinned entries are explicit intent, the recent-N list an automatic backfill; both share ONE
  // budget and the recent loop runs first, so pins are ranked here and reserve their share before
  // it can spend.
  const pinnedLocal = localPool.filter((e) => e.pinned);
  const pinnedGlobal = globalPool.filter((e) => e.pinned);
  const rankedPinned = rankPinned(plan, pinnedLocal, pinnedGlobal, nowP);
  const recentBudget = Math.max(0, effBudget - reservePinned(rankedPinned, effBudget));

  // Prompt recall gates the backfill on the prompt instead of recency.
  if (plan.promptRecallPending) {
    const candidates = (): PromptCandidate[] =>
      promptRecallCandidates({ plan, pools, admit: admission.admit, rankedPinned, nowP });
    backfillFromPrompt(opts, plan, { pinnedCfg, candidates, picked, recentBudget });
  } else if (plan.includeRecent > 0) {
    backfillRecent(plan, { localPool, globalPool, picked, recentBudget, nowP });
  }

  admitWithinBudget(rankedPinned, picked, effBudget, rejectOverBudget(obs));
  return picked.items;
}

/** The loaded rows offered to the observer, then one copy of each memory across both stores. */
function loadedOneCopy(plan: ContextPlan, pools: ContextPools): [MemoryEntry[], MemoryEntry[]] {
  const { obs } = plan;
  const localEntries = pools.local.entries;
  const globalEntries = pools.global.entries;
  obs?.offer(localEntries, plan.primaryIsGlobal);
  obs?.offer(globalEntries, true);
  const [localPool, globalPool] = oneCopyPerMemory(
    localEntries,
    globalEntries,
    plan.now,
    plan.strength,
  );
  obs?.dropMissing(
    [...localEntries, ...globalEntries],
    [...localPool, ...globalPool],
    'load',
    'duplicate',
  );
  return [localPool, globalPool];
}

function rankPinned(
  plan: ContextPlan,
  pinnedLocal: MemoryEntry[],
  pinnedGlobal: MemoryEntry[],
  nowP: Date,
): ContextResultEntry[] {
  const { strength } = plan;
  return [
    ...pinnedLocal.map((e) => ({ entry: e, isGlobal: plan.primaryIsGlobal })),
    ...pinnedGlobal.map((e) => ({ entry: e, isGlobal: true })),
  ]
    .map(({ entry, isGlobal }) => {
      const scopeBoost = scopeBoostFor(scopeMatch(entry.tags, plan.activeScope));
      return {
        entry,
        score:
          calculateStrengthAt(entry, nowP, strength) *
          (isGlobal ? GLOBAL_DISCOUNT : 1) *
          scopeBoost,
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

function rejectOverBudget(
  obs: DeliveryObserver | undefined,
): ((row: ContextResultEntry) => void) | undefined {
  return (
    obs &&
    ((r) =>
      obs.reject(r.entry, { stage: 'budget', reason: 'budget', score: r.score, tokens: r.tokens }))
  );
}

function backfillFromPrompt(
  opts: ContextOptions,
  plan: ContextPlan,
  options: BackfillFromPromptOptions,
): void {
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

interface PromptRecallCandidatesOptions {
  readonly plan: ContextPlan;
  readonly pools: ContextPools;
  readonly admit: (e: MemoryEntry) => boolean;
  readonly rankedPinned: ContextResultEntry[];
  readonly nowP: Date;
}

// Candidates came off the ambient load's own connection (the recall request), not a fresh open.
function promptRecallCandidates({
  plan,
  pools,
  admit,
  rankedPinned,
  nowP,
}: PromptRecallCandidatesOptions): PromptCandidate[] {
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
    if (why !== null && why !== 'pinned') obs?.reject(e, { stage: 'eligible', reason: why });
    return why === null;
  };
  obs?.offer(pools.local.recall ?? [], primaryIsGlobal, 'prompt-recall');
  obs?.offer(pools.global.recall ?? [], true, 'prompt-recall');
  const localEligible = (pools.local.recall ?? []).filter(eligible);
  const globalEligible = (pools.global.recall ?? []).filter(eligible);
  const { strength } = plan;
  const [localCandidates, globalCandidates] = oneCopyPerMemory(
    localEligible,
    globalEligible,
    nowP,
    strength,
  );
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
  const { strength } = plan;
  const candidates = [
    ...localPool.map((entry) => ({ entry, isGlobal: plan.primaryIsGlobal })),
    ...globalPool.map((entry) => ({ entry, isGlobal: true })),
  ];
  const recent = newestWorthSurfacing(candidates, plan.includeRecent).map(
    ({ entry, isGlobal }) => ({
      entry,
      score: calculateStrengthAt(entry, nowP, strength) * (isGlobal ? GLOBAL_DISCOUNT : 1),
      tokens: plan.price(entry, isGlobal),
      isGlobal,
    }),
  );
  admitWithinBudget(recent, picked, recentBudget, rejectOverBudget(plan.obs));
}

/** No query: the strongest memories by strength, up to budget. */
export function selectStrongest(
  plan: ContextPlan,
  left: number,
  pools: ContextPools,
): ContextResultEntry[] {
  const { now, strength } = plan;
  const [localPool, globalPool] = oneCopyPerMemory(
    pools.local.entries,
    pools.global.entries,
    now,
    strength,
  );
  const localRanked = localPool.map((e) => ({
    entry: e,
    score: calculateStrengthAt(e, now, strength),
    tokens: plan.price(e, plan.primaryIsGlobal),
    isGlobal: plan.primaryIsGlobal,
  }));

  const globalRanked = globalPool.map((e) => ({
    entry: e,
    score: calculateStrengthAt(e, now, strength) * GLOBAL_DISCOUNT,
    tokens: plan.price(e, true),
    isGlobal: true,
  }));

  return strongestWithin(localRanked, globalRanked, left);
}
