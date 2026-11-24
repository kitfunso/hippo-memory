import { calculateStrength, type StrengthModel } from '../../base/memory/strength.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { isWorthSurfacing } from '../../base/memory/memory-quality.js';
import { identityText } from '../../base/util/same-text.js';
import { DEFAULT_LOCAL_BUMP } from '../../base/rank/search-types.js';
import { compareScoredResults } from '../../base/rank/compare.js';
import { scopeMatch } from '../../base/rank/active-scope.js';
import { scopeBoostFor } from '../../domain/search/boosts.js';
import type { HippoConfig } from '../../base/config/config.js';
import {
  promptTokens,
  memoryTokens,
  gatePromptRecall,
  PROMPT_RECALL_MAX_CHARS,
} from '../../base/rank/prompt-recall.js';
import { rankBm25 } from '../../domain/search/bm25-search.js';
import type { DeliveryObserver } from '../delivery/delivery-recorder.js';
import type { ContextOptions, ContextResultEntry } from './context-types.js';
import {
  admitWithinBudget,
  newestWorthSurfacing,
  pinsWithinCap,
  promptRecallGateOf,
  promptRecallShareOf,
  strongestWithin,
  type Picked,
} from '../../domain/context/select-policy.js';
import type { ContextPlan } from './context-plan.js';
import type { ContextAdmission, ContextPools } from './context-pools.js';
import { findableText } from '../../base/memory/lead-in.js';

const GLOBAL_DISCOUNT = 1 / DEFAULT_LOCAL_BUMP;

export function oneCopyPerMemory(
  local: readonly MemoryEntry[],
  global: readonly MemoryEntry[],
  now: Date,
  strength: StrengthModel,
): [MemoryEntry[], MemoryEntry[]] {
  const score = (e: MemoryEntry, isGlobal: boolean): number =>
    calculateStrength(e, now, strength) * (isGlobal ? GLOBAL_DISCOUNT : 1);
  const best = new Map<string, { entry: MemoryEntry; isGlobal: boolean }>();
  const offer = (entry: MemoryEntry, isGlobal: boolean): void => {
    const held = best.get(identityText(entry));
    const wins =
      !held ||
      (held.entry.pinned !== entry.pinned
        ? entry.pinned
        : score(entry, isGlobal) > score(held.entry, held.isGlobal));
    if (wins) best.set(identityText(entry), { entry, isGlobal });
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
  const effBudget = left;
  const nowP = plan.now;
  const [localPool, globalPool] = loadedOneCopy(plan, pools);
  const picked: Picked<ContextResultEntry> = { items: [], ids: new Set<string>(), used: 0 };

  const pinnedLocal = localPool.filter((e) => e.pinned);
  const pinnedGlobal = globalPool.filter((e) => e.pinned);
  const rankedPinned = rankPinned(plan, pinnedLocal, pinnedGlobal, nowP);
  const share = plan.promptRecallPending ? promptRecallShareOf(pinnedCfg.pinnedInject) : 0;
  const cap = effBudget - Math.floor(effBudget * share);
  const pins = pinsWithinCap(rankedPinned, cap, rejectOverBudget(obs));
  const recentBudget = Math.max(0, effBudget - pins.reduce((sum, r) => sum + r.tokens, 0));

  if (plan.promptRecallPending) {
    const candidates = (prompt: ReadonlySet<string>): PromptCandidate[] =>
      promptRecallCandidates({ plan, pools, admit: admission.admit, rankedPinned, nowP, prompt });
    backfillFromPrompt(opts, plan, { pinnedCfg, candidates, picked, recentBudget });
  } else if (plan.includeRecent > 0) {
    backfillRecent(plan, { localPool, globalPool, picked, recentBudget, nowP });
  }

  admitWithinBudget(pins, picked, effBudget, rejectOverBudget(obs));
  return picked.items;
}

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
          calculateStrength(entry, nowP, strength) * (isGlobal ? GLOBAL_DISCOUNT : 1) * scopeBoost,
        tokens: plan.price(entry, isGlobal),
        isGlobal,
      };
    })
    .sort(compareScoredResults);
}

interface BackfillFromPromptOptions {
  readonly pinnedCfg: HippoConfig;
  readonly candidates: (prompt: ReadonlySet<string>) => PromptCandidate[];
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
  const candidateItems = candidates(p);
  const cleared = gatePromptRecall(p, candidateItems, {
    ...gate,
    maxItems: Number.POSITIVE_INFINITY,
  });
  const kept = orderLikeRecall(opts.prompt ?? '', cleared, plan).slice(0, gate.maxItems);
  plan.obs?.gated(p, candidateItems, gate, kept);
  const rows = kept.map((g) => ({
    entry: g.item.entry,
    score: g.score,
    tokens: plan.price(g.item.entry, g.item.isGlobal, true),
    isGlobal: g.item.isGlobal,
    promptRecall: true,
  }));
  admitWithinBudget(rows, picked, recentBudget, rejectOverBudget(plan.obs));
}

type GatedCandidates = ReturnType<typeof gatePromptRecall<PromptCandidate>>;

function orderLikeRecall(
  prompt: string,
  cleared: GatedCandidates,
  plan: ContextPlan,
): GatedCandidates {
  const waiting = new Map(cleared.map((g) => [g.item.entry.id, g]));
  const ranked = rankBm25(
    prompt.slice(0, PROMPT_RECALL_MAX_CHARS),
    cleared.map((g) => g.item.entry),
    {
      scope: plan.activeScope,
      runtime: plan.config.runtime,
      switches: plan.switches,
      now: plan.now,
      budget: Number.POSITIVE_INFINITY,
    },
  );
  const ordered: GatedCandidates = [];
  for (const { entry } of ranked) {
    const g = waiting.get(entry.id);
    if (g === undefined) continue;
    ordered.push(g);
    waiting.delete(entry.id);
  }
  return [...ordered, ...cleared.filter((g) => waiting.has(g.item.entry.id))];
}

interface PromptRecallCandidatesOptions {
  readonly plan: ContextPlan;
  readonly pools: ContextPools;
  readonly admit: (e: MemoryEntry) => boolean;
  readonly rankedPinned: ContextResultEntry[];
  readonly nowP: Date;
  readonly prompt: ReadonlySet<string>;
}

function promptRecallCandidates({
  plan,
  pools,
  admit,
  rankedPinned,
  nowP,
  prompt,
}: PromptRecallCandidatesOptions): PromptCandidate[] {
  const { obs, primaryIsGlobal } = plan;
  const pinnedText = new Set(rankedPinned.map((r) => identityText(r.entry)));
  const ineligibleReason = (e: MemoryEntry): 'scope' | 'pinned' | 'quality' | 'duplicate' | null =>
    !admit(e)
      ? 'scope'
      : e.pinned
        ? 'pinned'
        : !isWorthSurfacing(e)
          ? 'quality'
          : pinnedText.has(identityText(e))
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
  return promptCandidateItems(localCandidates, globalCandidates, primaryIsGlobal, prompt);
}

function promptCandidateItems(
  localCandidates: MemoryEntry[],
  globalCandidates: MemoryEntry[],
  primaryIsGlobal: boolean,
  prompt: ReadonlySet<string>,
): PromptCandidate[] {
  const seenCandidateIds = new Set<string>();
  const candidateItems: PromptCandidate[] = [];
  for (const [entries, isGlobal] of [
    [localCandidates, primaryIsGlobal],
    [globalCandidates, true],
  ] as const) {
    for (const e of entries) {
      if (seenCandidateIds.has(e.id)) continue;
      seenCandidateIds.add(e.id);
      candidateItems.push({
        id: e.id,
        tokens: memoryTokens(findableText(e), prompt),
        entry: e,
        isGlobal,
      });
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
      score: calculateStrength(entry, nowP, strength) * (isGlobal ? GLOBAL_DISCOUNT : 1),
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
