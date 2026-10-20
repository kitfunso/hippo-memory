// Recall composition: from the loaded candidates and the plan's reads to the reply and its rows; touches no store.

import { estimateTokens } from '../../util/token-text.js';
import { formatHandoffEvidenceLine } from '../../core/handoff.js';
import { DAG_LEVEL, type MemoryEntry } from '../../core/memory.js';
import { boostByGoals, type GoalStackBoostOptions } from '../../search/goal-boost.js';
import type { ForwardClaimMatch } from '../../learn/forward-claim-detector.js';
import type { RecallWrites } from '../../store/port.js';
import { churnStaleFactor } from '../../search/boosts.js';
import type { RerankStep } from '../../core/search-types.js';
import { compareEntryIdentity } from '../../core/compare.js';
import { dropHeldCopies, duplicateKey, storedTextKeys } from '../../util/same-text.js';
import { eligibleSummaryParents } from '../summary-parents.js';
import { classifyOriginProject, projectNames } from '../../core/project-identity.js';
import { autodebiasMode, decidePlanningFallacy, detectPlanningClaim } from '../../predictions/planning-fallacy.js';
import { detectAvailabilityBias, type AvailabilityHint } from '../availability.js';
import { passesScopeFilterForRecall } from '../../core/recall-scope.js';
import type {
  RecallSuppressionSummary,
  RecallOptions,
  RecallResult,
  RecallResultItem,
  ContinuityBlock,
} from './types.js';
import type { Context } from '../types.js';
import {
  anchoringRows,
  availabilityRows,
  biasHintEnabled,
  callerOf,
  detectAnchoring,
  hashQueryText,
  recallAuditMetadata,
  recallAuditRow,
  type AnchoringHint,
} from './finish.js';
import type { ActiveGoals, PlanningFallacyEvidence } from '../../store/port/types.js';
import type { RecallTraceInput, GoalRecallLogRow } from '../../store/port/recall-writes.js';

const DEFAULT_RECALL_LIMIT = 10;

export function recallOrigin(opts: RecallOptions): readonly string[] | undefined {
  const project = opts.filter?.project;
  return project ? projectNames(project) : undefined;
}

function inCallerProject(entry: MemoryEntry, opts: RecallOptions): boolean {
  const project = opts.filter?.project;
  return !project || classifyOriginProject(entry.originProject, project) !== 'cross-project';
}

/** The scope-admitted candidates in churn order, and the top `limit` of them. */
interface CandidateWindow {
  entries: MemoryEntry[];
  baseSlice: MemoryEntry[];
  droppedPreRank: number;
  droppedByBudget: number;
}

/** What a recall reads once its candidates are known, worked out first so the reads can go to hippo.db or the port. */
export interface RecallPlan {
  limit: number;
  window: CandidateWindow;
  /** The caller's personal scope, from the authenticated actor. */
  personalScope: string | undefined;
  /** Set when a session and no explicit goal tag ask for the goal-stack boost. */
  goalBoost: GoalStackBoostOptions | null;
  /** Overflowed children by summary parent, for the parents that may stand in for them; read only when not empty. */
  overflow: Map<string, MemoryEntry[]>;
  claim: ForwardClaimMatch | null;
}

/** The rows a plan asked for; each is empty or null when the plan did not ask. */
export interface RecallReads {
  goals: ActiveGoals | null;
  parents: MemoryEntry[];
  freshRaws: MemoryEntry[];
  continuity: ContinuityBlock | undefined;
  planning: PlanningFallacyEvidence | null;
}

/** The bands recall returns, plus the counts the suppression summary reports and the goal log rows the boost earned. */
interface RankedBands {
  rankedOut: RecallResultItem[];
  baseSlice: MemoryEntry[];
  heldDropped: number;
  summarySubstitutions: number;
  freshTailAdded: number;
  goalLog: GoalRecallLogRow[];
}

interface AnchoringOutcome {
  anchoringHint: AnchoringHint | null;
  suppressedByInterference: number;
}

/** The reply, and the rows the store writes once it is composed. */
export interface ComposedRecall {
  result: RecallResult;
  writes: RecallWrites;
}

type ScoredEntry = { entry: MemoryEntry; score: number };
type SummaryDecoration = { entry: MemoryEntry; childIds: string[] };

export function planRecall(
  ctx: Context,
  opts: RecallOptions,
  all: MemoryEntry[],
  personalScope: string | undefined,
): RecallPlan {
  const limit = opts.window?.limit ?? DEFAULT_RECALL_LIMIT;
  const window = admitCandidates(opts, all, limit, personalScope);
  const { sessionId, goalTag } = opts.boost ?? {};
  return {
    limit,
    window,
    personalScope,
    goalBoost: sessionId && !goalTag ? { sessionId, tenantId: ctx.tenantId, limit } : null,
    overflow:
      (opts.window?.summarizeOverflow ?? true) && window.entries.length > limit
        ? overflowGroups(window, limit)
        : new Map(),
    claim: detectPlanningClaim(opts.query, { mode: autodebiasMode(ctx.config.runtime) }),
  };
}

/** The reply and the rows it writes, from the candidates and the plan's reads; touches no store.
 *  `auditWindow` false: the caller shows a cut of the window and audits the rows it shows. */
interface ComposeRecallOptions {
  readonly windowSize: number;
  readonly all: MemoryEntry[];
  readonly plan: RecallPlan;
  readonly reads: RecallReads;
  readonly auditWindow?: boolean;
}

export function composeRecall(ctx: Context, opts: RecallOptions, options: ComposeRecallOptions): ComposedRecall {
  const { windowSize, all, plan, reads, auditWindow = true } = options;
  const { window } = plan;
  const bands = rankBands(opts, plan, reads);
  const rankedOut = bands.rankedOut;
  const continuity = reads.continuity
    ? scopeContinuity(reads.continuity, opts.filter?.scope, plan.personalScope)
    : undefined;
  // Query-derived, so MCP and CLI read this one hint instead of recomputing; HIPPO_AUTODEBIAS=off disables it.
  const planning =
    plan.claim && reads.planning
      ? decidePlanningFallacy(plan.claim, reads.planning, ctx.tenantId, ctx.actor.subject)
      : null;
  const { anchoringHint, suppressedByInterference } = detectRecallAnchoring(ctx, opts, rankedOut[0]?.id ?? null);
  const availabilityHint = detectRecallAvailability(ctx, opts, bands.baseSlice, window.entries);

  const result: RecallResult = {
    results: rankedOut,
    total: window.entries.length,
    tokens: rankedOut.reduce((acc, r) => acc + estimateTokens(r.content), 0),
    continuity,
    continuityTokens: continuity ? continuityTokensOf(continuity) : undefined,
    windowSize,
    suppressionSummary: {
      totalCandidates: all.length,
      droppedPreRank: window.droppedPreRank + bands.heldDropped,
      droppedByBudget: window.droppedByBudget,
      summarySubstitutionsAdded: bands.summarySubstitutions,
      freshTailAdded: bands.freshTailAdded,
      suppressedByInterference,
    } satisfies RecallSuppressionSummary,
  };
  // The hint and the no-class-match / tiebreak watching variant are mutually exclusive; both go out as optional fields.
  if (planning?.output.hint) result.planningFallacyHint = planning.output.hint;
  if (planning?.output.watching) result.planningFallacyWatching = planning.output.watching;
  if (anchoringHint) result.anchoringHint = anchoringHint;
  if (availabilityHint) result.availabilityHint = availabilityHint;

  const who = callerOf(ctx);
  const audit = auditWindow
    ? [recallAuditRow(who, 'recall', undefined, recallAuditMetadata(opts.query, rankedOut.length))]
    : [];
  if (planning?.audit) audit.push(planning.audit);
  audit.push(...anchoringRows(who, anchoringHint), ...availabilityRows(who, availabilityHint));
  return { result, writes: { goalLog: bands.goalLog, audit, trace: recallTrace(ctx, opts, rankedOut) } };
}

// The SQL load already applied tenant and scope; a recall candidate loader must go through store.searchRecallEntries.
function admitCandidates(
  opts: RecallOptions,
  all: MemoryEntry[],
  limit: number,
  personalScope: string | undefined,
): CandidateWindow {
  const current = all.filter((e) => !e.supersededBy);
  const scope = opts.filter?.scope;
  let entries: typeof all;
  if (scope !== undefined && scope !== '') {
    // SQL already exact-matched; the JS filter is defense-in-depth against a SQL-clause regression.
    entries = current.filter((e) => e.scope === scope);
  } else {
    // SQL pre-filtered ':private:' loosely before the window; this is the exact anchored `<source>:private:*` rule.
    entries = current.filter((e) => passesScopeFilterForRecall(e.scope ?? null, undefined, personalScope));
  }
  const droppedPreRank = all.length - entries.length;
  entries = entries
    .map((e, i) => ({ e, s: (1 - i / entries.length) * churnStaleFactor(e) }))
    .sort((a, b) => b.s - a.s)
    .map((r) => r.e);
  // BM25 ordering already comes from store.searchRecallEntries; cap to `limit`.
  const baseSlice = entries.slice(0, limit);
  return { entries, baseSlice, droppedPreRank, droppedByBudget: entries.length - baseSlice.length };
}

// The goal-stack boost touches the primary band only; the fresh-tail and summary bands keep their fixed placement.
function rankBands(opts: RecallOptions, plan: RecallPlan, reads: RecallReads): RankedBands {
  const { window, limit, personalScope } = plan;
  let baseScored: ScoredEntry[] = window.baseSlice.map((entry, idx) => ({
    entry,
    score: Math.max(0, 1 - idx / Math.max(1, limit)),
  }));
  // Allocated only under explain, so the boost's default-path math stays byte-identical.
  const explainTrace = opts.trace?.explain ? new Map<string, RerankStep>() : undefined;
  let goalLog: GoalRecallLogRow[] = [];
  if (plan.goalBoost && reads.goals) {
    const boost = boostByGoals(baseScored, reads.goals, { ...plan.goalBoost, trace: explainTrace });
    baseScored = boost.results;
    goalLog = boost.log;
  }
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
  const baseRanked = baseScored.map((r) => baseItem(r, opts, explainTrace));
  const summaryRanked = substituted.map((s) => summaryItem(s, opts));
  const freshRanked =
    (opts.window?.freshTailCount ?? 0) > 0
      ? freshTailBand(opts, {
          recent: reads.freshRaws,
          baseRanked,
          summaryRanked,
          shownEntries: opts.filter?.keepHeldCopies ? [] : [...baseSlice, ...substituted.map((s) => s.entry)],
          personalScope,
        })
      : [];
  return {
    rankedOut: [...freshRanked, ...baseRanked, ...summaryRanked],
    baseSlice,
    heldDropped,
    summarySubstitutions: substituted.length,
    freshTailAdded: freshRanked.length,
    goalLog,
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

// When the overflow holds 2+ children of one level-2 summary, that summary stands in for them, capped at 30% of
// `limit`. Each one is tenant-scoped and re-checked against the scope filter; drillDown recovers the children.
interface SubstituteOverflowOptions {
  readonly overflowByParent: Map<string, MemoryEntry[]>;
  readonly parents: MemoryEntry[];
  readonly limit: number;
  readonly personalScope: string | undefined;
}

function substituteOverflow(opts: RecallOptions, options: SubstituteOverflowOptions): SummaryDecoration[] {
  const { overflowByParent, parents, limit, personalScope } = options;
  const eligibleParents = eligibleSummaryParents(parents, opts.filter?.scope, personalScope, opts.filter?.project);
  const maxSub = Math.max(1, Math.ceil(limit * SUMMARY_SUB_FRACTION));
  // Most overflowed children first; compareEntryIdentity only breaks a tie, which used to fall to scan order.
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
 * Overflowed leaf rows by summary parent, kept only for a parent with 2+ of them that is not already in the base band.
 */
function overflowGroups(window: CandidateWindow, limit: number): Map<string, MemoryEntry[]> {
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
  return new Map([...overflowByParent].filter(([pid, children]) => children.length >= 2 && !baseIds.has(pid)));
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

// The last N raw rows, so "what did I just see" always covers the recent window. A recent row already in the BM25 band
// is only tagged isFreshTail; new ones are prepended, so every recent row appears exactly once.
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
    (m) => passesScopeFilterForRecall(m.scope ?? null, opts.filter?.scope, personalScope) && inCallerProject(m, opts),
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

// The trace is observability, not retrieval state; a caller that traces its own result set suppresses it.
function recallTrace(ctx: Context, opts: RecallOptions, rankedOut: RecallResultItem[]): RecallTraceInput | undefined {
  if (opts.trace?.suppressRecallTrace) return undefined;
  return {
    tenantId: ctx.tenantId,
    sessionId: opts.boost?.sessionId ?? null,
    pipeline: 'api',
    query: opts.query,
    explainMode: opts.trace?.explain === true,
    results: rankedOut.map((r) => ({
      memoryId: r.id,
      score: r.score,
      rerankSteps: r.rerankTrace,
    })),
  };
}

// The memory-recall scope rule: an explicit scope must match exactly; without one, private and legacy rows are denied.
function scopeContinuity(
  block: ContinuityBlock,
  scope: string | undefined,
  personalScope: string | undefined,
): ContinuityBlock {
  const rowScope = (r: { scope?: string | null } | null | undefined): string | null => r?.scope ?? null;
  const { activeSnapshot: snapshot, sessionHandoff } = block;
  return {
    activeSnapshot: snapshot && passesScopeFilterForRecall(rowScope(snapshot), scope, personalScope) ? snapshot : null,
    sessionHandoff:
      sessionHandoff && passesScopeFilterForRecall(rowScope(sessionHandoff), scope, personalScope)
        ? sessionHandoff
        : null,
    recentSessionEvents: block.recentSessionEvents.filter((e) =>
      passesScopeFilterForRecall(rowScope(e), scope, personalScope),
    ),
  };
}

function continuityTokensOf(c: ContinuityBlock): number {
  const filteredSnapshot = c.activeSnapshot;
  const filteredHandoff = c.sessionHandoff;
  const tokenCount = (s?: string | null): number => (s ? estimateTokens(s) : 0);
  return (
    tokenCount(filteredSnapshot?.task) +
    tokenCount(filteredSnapshot?.summary) +
    tokenCount(filteredSnapshot?.next_step) +
    tokenCount(filteredHandoff?.summary) +
    tokenCount(filteredHandoff?.nextAction) +
    (filteredHandoff?.artifacts ?? []).reduce((acc, a) => acc + tokenCount(a), 0) +
    (filteredHandoff?.constraints ?? []).reduce((acc, c) => acc + tokenCount(c), 0) +
    tokenCount(filteredHandoff?.evidence ? formatHandoffEvidenceLine(filteredHandoff.evidence) : null) +
    tokenCount(filteredHandoff?.outcome) +
    tokenCount(filteredHandoff?.targetRuntime) +
    tokenCount(filteredHandoff?.cardId) +
    c.recentSessionEvents.reduce((acc, e) => acc + tokenCount(e.content), 0)
  );
}

// A pure read of the caller's recallHistory snapshot against this top-1. HIPPO_ANCHORING=off skips even the detect
// call; CLI paths pass no history (cmdRecall computes its own hint), so the hint stays absent there.
function detectRecallAnchoring({ config }: Context, opts: RecallOptions, topMemoryId: string | null): AnchoringOutcome {
  const history = opts.hints?.recallHistory;
  if (!biasHintEnabled(config, 'anchoring') || !history) return { anchoringHint: null, suppressedByInterference: 0 };
  const queryHash = hashQueryText(opts.query);
  const anchoringHint = detectAnchoring(history, queryHash, topMemoryId);
  return { anchoringHint, suppressedByInterference: anchoringHint?.reason === 'memory_dominance' ? 1 : 0 };
}

// Compares the returned top-K's ages with the scope-filtered pool it came from, never `all`, whose hidden rows would
// leak pool shape. A soft warning only; HIPPO_AVAILABILITY=off or a caller computing its own hint skips it.
function detectRecallAvailability(
  ctx: Context,
  opts: RecallOptions,
  baseSlice: MemoryEntry[],
  entries: MemoryEntry[],
): AvailabilityHint | null {
  if (!biasHintEnabled(ctx.config, 'availability') || opts.hints?.suppressAvailabilityHint) return null;
  return detectAvailabilityBias({
    topK: baseSlice.map((e) => ({ id: e.id, created: e.created })),
    pool: entries.map((e) => ({ id: e.id, created: e.created })),
  });
}
