// How the result bands are placed: the goal boost, the summary substitution and the fresh tail.
import { DAG_LEVEL, type MemoryEntry } from '../../base/memory/entry.js';
import { boostByGoals } from '../../domain/search/goal-boost.js';
import type { RerankStep } from '../../base/rank/search-types.js';
import { compareEntryIdentity } from '../../base/rank/compare.js';
import { dropHeldCopies, duplicateKey, storedTextKeys } from '../../base/util/same-text.js';
import { eligibleSummaryParents } from '../summary-parents.js';
import { classifyOriginProject } from '../../base/scope/project-identity.js';
import { passesScopeFilterForRecall } from '../../base/scope/recall-scope.js';
import type { RecallOptions, RecallResultItem } from './types.js';
import type { GoalRecallLogRow } from '../../base/ports/store/recall-writes.js';
import type { CandidateWindow, RecallPlan, RecallReads } from './compose.js';

function inCallerProject(entry: MemoryEntry, opts: RecallOptions): boolean {
  const project = opts.filter?.project;
  return !project || classifyOriginProject(entry.originProject, project) !== 'cross-project';
}

/** The bands recall returns, plus the counts the suppression summary reports and the goal log
 * rows the boost earned. */
export interface RankedBands {
  rankedOut: RecallResultItem[];
  baseSlice: MemoryEntry[];
  heldDropped: number;
  summarySubstitutions: number;
  freshTailAdded: number;
  goalLog: GoalRecallLogRow[];
}

type ScoredEntry = { entry: MemoryEntry; score: number };
type SummaryDecoration = { entry: MemoryEntry; childIds: string[] };

/** The primary band in window order, goal-boosted when the plan asks, and the explain trace
 * the boost wrote to. */
interface BoostedBase {
  baseScored: ScoredEntry[];
  goalLog: GoalRecallLogRow[];
  explainTrace: Map<string, RerankStep> | undefined;
}

// The goal-stack boost touches the primary band only; the fresh-tail and summary bands keep their
// fixed placement.
function boostBase(opts: RecallOptions, plan: RecallPlan, reads: RecallReads): BoostedBase {
  const { window, limit } = plan;
  const baseScored: ScoredEntry[] = window.baseSlice.map((entry, idx) => ({
    entry,
    score: Math.max(0, 1 - idx / Math.max(1, limit)),
  }));
  // Allocated only under explain, so the boost's default-path math stays byte-identical.
  const explainTrace = opts.trace?.explain ? new Map<string, RerankStep>() : undefined;
  if (!plan.goalBoost || !reads.goals) return { baseScored, goalLog: [], explainTrace };
  const boost = boostByGoals(baseScored, reads.goals, { ...plan.goalBoost, trace: explainTrace });
  return { baseScored: boost.results, goalLog: boost.log, explainTrace };
}

export function rankBands(opts: RecallOptions, plan: RecallPlan, reads: RecallReads): RankedBands {
  const { limit, personalScope } = plan;
  const boosted = boostBase(opts, plan, reads);
  let baseScored = boosted.baseScored;
  let substituted = substituteOverflow(opts, {
    overflowByParent: plan.overflow,
    parents: reads.parents,
    limit,
    personalScope,
  });
  let heldDropped = 0;
  if (!opts.filter?.keepHeldCopies) {
    const kept = withoutHeldCopies(baseScored, substituted);
    ({ heldDropped, base: baseScored, summaries: substituted } = kept);
  }
  const baseSlice = baseScored.map((r) => r.entry);
  const baseRanked = baseScored.map((r) => baseItem(r, opts, boosted.explainTrace));
  const summaryRanked = substituted.map((s) => summaryItem(s, opts));
  const freshRanked =
    (opts.window?.freshTailCount ?? 0) > 0
      ? freshTailBand(opts, {
          recent: reads.freshRaws,
          baseRanked,
          summaryRanked,
          shownEntries: opts.filter?.keepHeldCopies
            ? []
            : [...baseSlice, ...substituted.map((s) => s.entry)],
          personalScope,
        })
      : [];
  return {
    rankedOut: [...freshRanked, ...baseRanked, ...summaryRanked],
    baseSlice,
    heldDropped,
    summarySubstitutions: substituted.length,
    freshTailAdded: freshRanked.length,
    goalLog: boosted.goalLog,
  };
}

/** The base rows and summaries whose text no other row holds, and how many base rows went. */
function withoutHeldCopies(base: ScoredEntry[], summaries: SummaryDecoration[]) {
  const entries = [...base.map((r) => r.entry), ...summaries.map((s) => s.entry)];
  const shownIds = new Set(dropHeldCopies(entries, (e) => e).map((e) => e.id));
  return {
    heldDropped: base.filter((r) => !shownIds.has(r.entry.id)).length,
    base: base.filter((r) => shownIds.has(r.entry.id)),
    summaries: summaries.filter((s) => shownIds.has(s.entry.id)),
  };
}

// When the overflow holds 2+ children of one level-2 summary, that summary stands in for them,
// capped at 30% of `limit`. Each one is tenant-scoped and re-checked against the scope filter;
// drillDown recovers the children.
interface SubstituteOverflowOptions {
  readonly overflowByParent: Map<string, MemoryEntry[]>;
  readonly parents: MemoryEntry[];
  readonly limit: number;
  readonly personalScope: string | undefined;
}

function substituteOverflow(
  opts: RecallOptions,
  options: SubstituteOverflowOptions,
): SummaryDecoration[] {
  const { overflowByParent, parents, limit, personalScope } = options;
  const eligibleParents = eligibleSummaryParents(
    parents,
    opts.filter?.scope,
    personalScope,
    opts.filter?.project,
  );
  const maxSub = Math.max(1, Math.ceil(limit * SUMMARY_SUB_FRACTION));
  // Most overflowed children first; compareEntryIdentity only breaks a tie, which used to fall to
  // scan order.
  eligibleParents.sort((a, b) => {
    const ac = overflowByParent.get(a.id)?.length ?? 0;
    const bc = overflowByParent.get(b.id)?.length ?? 0;
    return bc !== ac ? bc - ac : compareEntryIdentity(a, b);
  });
  return eligibleParents.slice(0, maxSub).map((p) => ({
    entry: p,
    childIds: (overflowByParent.get(p.id) ?? []).map((e) => e.id),
  }));
}

/**
 * Overflowed leaf rows by summary parent, kept only for a parent with 2+ of them that is not
 * already in the base band.
 */
export function overflowGroups(window: CandidateWindow, limit: number): Map<string, MemoryEntry[]> {
  // The goal boost only re-scores the base band, so its ids are known before the boost runs.
  const baseIds = new Set(window.baseSlice.map((e) => e.id));
  const overflowByParent = new Map<string, MemoryEntry[]>();
  for (const e of window.entries.slice(limit)) {
    const parentId = e.dagParentId;
    if (!parentId) continue;
    if ((e.dagLevel ?? 0) > DAG_LEVEL.extracted) continue;
    const list = overflowByParent.get(parentId) ?? [];
    list.push(e);
    overflowByParent.set(parentId, list);
  }
  return new Map(
    [...overflowByParent].filter(([pid, children]) => children.length >= 2 && !baseIds.has(pid)),
  );
}

function baseItem(
  r: ScoredEntry,
  opts: RecallOptions,
  explainTrace: Map<string, RerankStep> | undefined,
): RecallResultItem {
  const item: RecallResultItem = {
    id: r.entry.id,
    content: r.entry.content,
    score: r.score,
    layer: r.entry.layer,
    strength: r.entry.strength,
  };
  // Only this band passes through the goal boost, so only it can carry a rerank step.
  if (opts.trace?.explain) {
    item.rerankPipeline = 'api';
    const step = explainTrace?.get(r.entry.id);
    if (step) item.rerankTrace = [step];
  }
  return item;
}

// A summary scores below the strong top-N matches but above the weakest leaves.
const SUMMARY_ITEM_SCORE = 0.5;
const FRESH_TAIL_ITEM_SCORE = 1.0;
// Summaries may take this share of the limit.
const SUMMARY_SUB_FRACTION = 0.3;

function summaryItem(s: SummaryDecoration, opts: RecallOptions): RecallResultItem {
  const item: RecallResultItem = {
    id: s.entry.id,
    content: s.entry.content,
    score: SUMMARY_ITEM_SCORE,
    layer: s.entry.layer,
    strength: s.entry.strength,
    isSummary: true,
    substitutedFor: s.childIds,
    descendantCount: s.entry.descendantCount ?? s.childIds.length,
  };
  if (opts.trace?.explain) item.rerankPipeline = 'api';
  return item;
}

// The last N raw rows, so "what did I just see" always covers the recent window. A recent row
// already in the BM25 band is only tagged isFreshTail; new ones are prepended, so every recent row
// appears exactly once.
interface FreshTailBandOptions {
  readonly recent: MemoryEntry[];
  readonly baseRanked: RecallResultItem[];
  readonly summaryRanked: RecallResultItem[];
  readonly shownEntries: MemoryEntry[];
  readonly personalScope: string | undefined;
}

function freshTailBand(opts: RecallOptions, options: FreshTailBandOptions): RecallResultItem[] {
  const { recent, baseRanked, summaryRanked, shownEntries, personalScope } = options;
  const recentScoped = recent.filter(
    (m) =>
      passesScopeFilterForRecall(m.scope ?? null, opts.filter?.scope, personalScope) &&
      inCallerProject(m, opts),
  );
  const recentIdSet = new Set(recentScoped.map((m) => m.id));
  for (const r of baseRanked) {
    if (recentIdSet.has(r.id)) r.isFreshTail = true;
  }
  const seenIds = new Set([...baseRanked.map((r) => r.id), ...summaryRanked.map((r) => r.id)]);
  const shownKeys = storedTextKeys(shownEntries);
  const freshRanked: RecallResultItem[] = [];
  for (const m of recentScoped) {
    if (seenIds.has(m.id) || shownKeys.has(duplicateKey(m.content))) continue;
    shownKeys.add(duplicateKey(m.content));
    const item: RecallResultItem = {
      id: m.id,
      content: m.content,
      score: FRESH_TAIL_ITEM_SCORE,
      layer: m.layer,
      strength: m.strength,
      isFreshTail: true,
    };
    if (opts.trace?.explain) item.rerankPipeline = 'api';
    freshRanked.push(item);
    seenIds.add(m.id);
  }
  return freshRanked;
}
