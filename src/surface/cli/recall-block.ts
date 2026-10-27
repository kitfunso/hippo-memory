// The `hippo recall` block: price the rows, write the hint lines and fit the text to the token budget.

import { DEFAULT_MIN_RESULTS, type SearchResult } from '../../base/rank/search-types.js';
import { tokenPurse } from '../../base/util/token-text.js';
import { dropHeldCopies } from '../../base/util/same-text.js';
import * as api from '../../api/index.js';
import type {
  PlanningFallacyHint,
  PlanningFallacyOutput,
  PlanningFallacyWatching,
} from '../../base/records/planning-fallacy.js';
import { sessionRing } from '../../api/recall/session-rings.js';
import { hashQueryText } from '../../api/recall/anchoring.js';
import {
  handoffText,
  printedTokens,
  sessionTrailText,
  settleTokens,
  snapshotText,
} from '../../api/context-render.js';
import type { RankRecallResult } from '../../api/recall/pipeline.js';
import {
  availabilityPool,
  cutoffClauses,
  detectRecallHints,
  suppressionSummary,
  type RecallHints,
} from '../render/recall-text.js';
import { recallRowOrigin, fitRecall, type RecallRowOrigin } from '../../api/recall/rows.js';
import { continuityTexts, recallEntryText, recallHeading } from './print.js';
import type { ParsedRecallFlags } from './recall-flags.js';

// JSON.stringify keeps quotes or parens in the matched phrase from blurring the line.
function planningLine(p: PlanningFallacyOutput): string | null {
  if (p.hint) {
    return (
      `Planning fallacy hint (class: ${p.hint.classTag}): ${p.hint.baserateSummary} ` +
      `[detected: ${JSON.stringify(p.hint.detectedPhrase)}]`
    );
  }
  if (p.watching) {
    return (
      `Planning fallacy: watching this query (reason: ${p.watching.reason}). ${p.watching.suggestion} ` +
      `[detected: ${JSON.stringify(p.watching.detectedPhrase)}]`
    );
  }
  return null;
}

function cutoffLine(shown: number, s: api.RecallSuppressionSummary): string | null {
  const clauses = cutoffClauses(s);
  return clauses.length > 0
    ? `Cutoff: showing ${shown} of ${s.totalCandidates} candidates; ${clauses.join('; ')}.`
    : null;
}

/** Each entry priced as the line it prints, with the source marker `--why` shows. */
export interface PricedEntries extends RecallRowOrigin {
  readonly entryText: (r: SearchResult) => string;
  readonly printCost: (r: SearchResult) => number;
}

export function priceRecallEntries(
  ctx: api.Context,
  query: string,
  parsed: ParsedRecallFlags,
): PricedEntries {
  const origin = recallRowOrigin(ctx, parsed.setting);
  const isGlobal = origin.isGlobal;
  const now = ctx.infra.clock();
  const entryText = (r: SearchResult): string =>
    recallEntryText({ r, query, showWhy: parsed.showWhy, isGlobal: isGlobal(r), now });
  const printCost = (r: SearchResult): number => printedTokens(entryText(r));
  return { globalOn: origin.globalOn, isGlobal, entryText, printCost };
}

export interface RankedRecall extends PricedEntries {
  readonly rank: RankRecallResult;
}

/** The bias hints over one shown list, and the cutoff counts `--why` prints. */
export interface RecallBlockHints extends RecallHints {
  readonly summary: api.RecallSuppressionSummary;
}

/** Hints for a list that dropped `held` merged copies. */
type HintsFor = (list: SearchResult[], held: number) => RecallBlockHints;

/** Each pipeline computes its hints over the list it returns, so they follow the list as it
 * shrinks. */
function recallHinter(
  ctx: api.Context,
  query: string,
  parsed: ParsedRecallFlags,
  rank: RankRecallResult,
): HintsFor {
  const { tenantId, sessionId } = parsed;
  // HIPPO_ANCHORING=off and HIPPO_AVAILABILITY=off skip the work entirely.
  const anchorRing = sessionRing(
    { config: ctx.config, tenantId, callers: ctx.callers },
    'cli',
    sessionId,
  );
  const queryHash = hashQueryText(query);
  const pool = availabilityPool(ctx.config, () => [...rank.localEntries, ...rank.globalEntries]);
  return (list, held) => {
    const { anchoring, availability } = detectRecallHints({ list, pool, anchorRing, queryHash });
    const summary = suppressionSummary(
      {
        // The total includes graph-surfaced rows, so total == preRank + byBudget + returned holds
        // for callers.
        totalCandidates: rank.totalCandidates + rank.graphAdded,
        droppedPreRank: rank.droppedPreRank + held,
        droppedByBudget: Math.max(
          0,
          rank.totalCandidates + rank.graphAdded - rank.droppedPreRank - held - list.length,
        ),
        summarySubstitutionsAdded: 0,
        freshTailAdded: 0,
      },
      anchoring,
    );
    return { anchoring, availability, summary };
  };
}

interface RecallRenderView {
  readonly query: string;
  readonly showWhy: boolean;
  readonly showPlan: boolean;
  readonly planText: string | null;
  readonly hasContinuity: boolean;
  readonly continuity: api.ContinuityBlock;
  readonly entryText: (r: SearchResult) => string;
}

function renderRecallBlock(
  list: SearchResult[],
  hints: RecallBlockHints,
  view: RecallRenderView,
): string {
  const { query, showWhy, showPlan, planText, hasContinuity, entryText } = view;
  const { activeSnapshot, sessionHandoff, recentSessionEvents } = view.continuity;
  const continuity = continuityTexts(activeSnapshot, sessionHandoff, recentSessionEvents);
  // The hint still prints when nothing matched, so the agent sees its track record.
  const plan = showPlan && planText !== null ? [planText, ''] : [];
  return settleTokens((t) => {
    if (list.length === 0) {
      const none = hasContinuity
        ? `(no memories matched "${query}")`
        : `No memories found for: ${query}`;
      return [...plan, ...(hasContinuity ? continuity : []), none].join('\n');
    }
    // Anchoring is the stronger pull, so it prints first; the Cutoff line sits above the list,
    // where a reader sees it.
    const lines = [...continuity];
    if (hints.anchoring) {
      lines.push(`[anchored_on: ${hints.anchoring.memoryId}] ${hints.anchoring.summary}`, '');
    }
    if (hints.availability) {
      const { recentCount, returnedCount, summary } = hints.availability;
      lines.push(`Availability bias (${recentCount}/${returnedCount} recent): ${summary}`, '');
    }
    lines.push(...plan);
    const cutoff = showWhy ? cutoffLine(list.length, hints.summary) : null;
    if (cutoff) lines.push(cutoff, '');
    lines.push(recallHeading(list.length, t, query), ...list.map(entryText));
    return lines.join('\n');
  });
}

/** Pays the continuity sections in print order after the header; one that does not fit is
 * dropped. */
function payContinuity(loaded: api.ContinuityBlock, sectionBudget: number) {
  let { activeSnapshot, sessionHandoff, recentSessionEvents } = loaded;
  const { pays, left } = tokenPurse(sectionBudget);
  if (activeSnapshot && !pays(printedTokens(snapshotText(activeSnapshot)))) activeSnapshot = null;
  if (sessionHandoff && !pays(printedTokens(handoffText(sessionHandoff)))) sessionHandoff = null;
  if (
    recentSessionEvents.length > 0 &&
    !pays(printedTokens(sessionTrailText(recentSessionEvents)))
  ) {
    recentSessionEvents = [];
  }
  const continuity: api.ContinuityBlock = { activeSnapshot, sessionHandoff, recentSessionEvents };
  return { continuity, continuityTokens: sectionBudget - left() };
}

/** One rendering of the block: the rows it lists, their hints and the text. */
interface RenderedRecall {
  readonly results: SearchResult[];
  readonly hints: RecallBlockHints;
  readonly recallText: string;
}

/** The block over one cut of the ranked rows. */
function renderRows(
  rows: SearchResult[],
  hintsFor: HintsFor,
  view: RecallRenderView,
): RenderedRecall {
  // Copies go after every cut, so a merged row the budget drops never hides its sources.
  const results = dropHeldCopies(rows, (r) => r.entry);
  const hints = hintsFor(results, rows.length - results.length);
  return { results, hints, recallText: renderRecallBlock(results, hints, view) };
}

interface FitRecallBlockOptions {
  ctx: api.Context;
  query: string;
  parsed: ParsedRecallFlags;
  ranked: RankedRecall;
  loaded: api.ContinuityBlock;
  planning: PlanningFallacyOutput;
}

/** The block that fits the budget, with the continuity and plan hint it paid for. */
export interface FittedRecall extends RenderedRecall {
  readonly continuity: api.ContinuityBlock;
  readonly continuityTokens: number;
  readonly planningFallacyHint: PlanningFallacyHint | null;
  readonly planningFallacyWatching: PlanningFallacyWatching | null;
}

/** Pays the continuity sections and the plan hint first, then fits the memories into what is
 * left. */
export function fitRecallBlock(options: FitRecallBlockOptions): FittedRecall {
  const { ctx, query, parsed, ranked, loaded, planning } = options;
  const { budget } = parsed;
  // Sections print ahead of the memories, so they are paid first, after the header; one that does
  // not fit is dropped.
  const sectionBudget = budget - printedTokens(recallHeading(budget, budget, query));
  const { continuity, continuityTokens } = payContinuity(loaded, sectionBudget);
  const { activeSnapshot, sessionHandoff, recentSessionEvents } = continuity;
  const hasContinuity =
    activeSnapshot !== null || sessionHandoff !== null || recentSessionEvents.length > 0;

  const plan = payPlanLine(planning, sectionBudget - continuityTokens);
  const { planningFallacyHint, planningFallacyWatching } = plan;

  const hintsFor = recallHinter(ctx, query, parsed, ranked.rank);
  const view: RecallRenderView = {
    query,
    showWhy: parsed.showWhy,
    showPlan: plan.showPlan,
    planText: plan.planText,
    hasContinuity,
    continuity,
    entryText: ranked.entryText,
  };
  const { results, hints, recallText } = fitMemories(ranked, parsed, plan.room, (rows) =>
    renderRows(rows, hintsFor, view),
  );
  return {
    results,
    hints,
    recallText,
    continuity,
    continuityTokens,
    planningFallacyHint,
    planningFallacyWatching,
  };
}

/** The plan line and its hints when they fit `left`, and the room the memories keep. */
interface PaidPlanLine {
  readonly planText: string | null;
  readonly showPlan: boolean;
  readonly room: number;
  readonly planningFallacyHint: PlanningFallacyHint | null;
  readonly planningFallacyWatching: PlanningFallacyWatching | null;
}

function payPlanLine(planning: PlanningFallacyOutput, left: number): PaidPlanLine {
  // The baserate hint depends on the query alone, so `retrieveWithCliCore` evaluates it and this
  // only prices the line.
  const planText = planningLine(planning);
  const planTokens = planText === null ? 0 : printedTokens(`${planText}\n`);
  const showPlan = planText !== null && planTokens <= left;
  return {
    planText,
    showPlan,
    room: showPlan ? left - planTokens : left,
    planningFallacyHint: showPlan ? (planning.hint ?? null) : null,
    planningFallacyWatching: showPlan ? (planning.watching ?? null) : null,
  };
}

function fitMemories(
  ranked: RankedRecall,
  parsed: ParsedRecallFlags,
  room: number,
  render: (rows: SearchResult[]) => RenderedRecall,
): RenderedRecall {
  return fitRecall(ranked.rank.results, {
    room,
    budget: parsed.budget,
    // The first --min-results are kept whatever they cost (the documented exception); the rest skip
    // and continue.
    floor: parsed.minResults ?? DEFAULT_MIN_RESULTS,
    cost: ranked.printCost,
    render,
    textOf: (r) => r.recallText,
  });
}
