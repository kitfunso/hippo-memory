// The `hippo recall` verb; main() loads it lazily from the command table.

import { envActiveScope, envHippoSessionId } from '../../base/util/env.js';
import type { CallerState } from '../../api/callers.js';
import { Layer } from '../../base/memory/memory.js';
import { DEFAULT_RECALL_BUDGET, type SearchResult } from '../../base/rank/search-types.js';
import { estimateTokens, shrinkToFit, tokenPurse } from '../../base/util/token-text.js';
import { dropHeldCopies } from '../../base/util/same-text.js';
import * as api from '../../api/index.js';
import type { PlanningFallacyOutput } from '../../domain/predictions/planning-fallacy.js';
import { hashQueryText, sessionRing, shownRecallRows } from '../../api/recall/finish.js';
import { handoffText, printedTokens, sessionTrailText, settleTokens, snapshotText } from '../../api/context-render.js';
import type {
  RankRecallResult,
  RankStage,
  RecallGraphHops,
  RecallGraphStream,
  RecallReranker,
} from '../../api/recall/pipeline.js';
import { availabilityPool, cutoffClauses, detectRecallHints, suppressionSummary } from '../render/recall-text.js';
import {
  recallRowOrigin,
  recallRerankerPick,
  recallStoreSetting,
  DEFAULT_MAX_NEIGHBORS,
  fitRecallRows,
  loadScopedContinuity,
  MAX_HOPS,
  recallJsonRow,
  type RecallRerankerPick,
} from '../../api/recall/rows.js';
import { cliApiContext, cliInfra, cliSecondStore } from './api-context.js';
import { printError } from './output.js';
import {
  type CliFlags,
  type CommandContext,
  type ParsedFlag,
  boolFlag,
  engineFlags,
  failLater,
  flagValueless,
  hasFlag,
  intFlagInRange,
  numberFlag,
  parseAsOfFlag,
  parseBudgetFlag,
  parseLimitFlag,
  stringFlag,
  stringFlagOrExit,
} from './flag-values.js';
import { requireInit } from './shared.js';
import { continuityTexts, recallEntryText, recallHeading } from './print.js';
import { continuityJson, type ContinuityBlockJson } from '../../api/continuity-json.js';
import { hostSessionId, hookStoreRoot } from './hook-runtime.js';
import { fail } from './exit.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';

const MAX_NEIGHBORS_FLAG = 200;

// JSON.stringify keeps quotes or parens in the matched phrase from blurring the line.
function planningLine(p: PlanningFallacyOutput): string | null {
  if (p.hint) {
    return `Planning fallacy hint (class: ${p.hint.classTag}): ${p.hint.baserateSummary} [detected: ${JSON.stringify(p.hint.detectedPhrase)}]`;
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

/** A flag the ranking stages read, rejected where the old mid-pipeline check printed its error. */
interface LateFlagError {
  stage: RankStage;
  fail: () => never;
}

interface RecallLateFlags {
  graphHops?: RecallGraphHops;
  reranker?: RecallReranker;
  salienceThreshold?: number;
  outcome?: string;
  layer?: string;
  error?: LateFlagError;
}

/** `--graph-stream` implies rrf fusion as well as the graph stream; the CLI fuses the local store only. */
function parseGraphStreamFlags(flags: CliFlags): RecallGraphStream {
  const hops = intFlagInRange(flags, 'graph-hops', { min: 1, max: MAX_HOPS, example: '2' });
  hops.fail?.();
  const seeds = intFlagInRange(flags, 'graph-seeds', { min: 1, example: '10' });
  seeds.fail?.();
  return { hops: hops.value, seeds: seeds.value };
}

function parseHopsFlags(flags: CliFlags): ParsedFlag<RecallGraphHops> {
  const hops = intFlagInRange(flags, 'hops', { min: 0, max: MAX_HOPS, example: '1' });
  if (hops.value === undefined) return { fail: hops.fail };
  const neighbors = intFlagInRange(flags, 'max-neighbors', { min: 1, max: MAX_NEIGHBORS_FLAG });
  if (neighbors.fail) return { fail: neighbors.fail };
  return { value: { hops: hops.value, maxNeighbors: neighbors.value ?? DEFAULT_MAX_NEIGHBORS } };
}

function parseRerankerFlag(flags: CliFlags): ParsedFlag<RecallReranker> {
  const nameRaw = stringFlag(flags, 'reranker');
  if (hasFlag(flags, 'reranker') && nameRaw === undefined) return { fail: failLater('--reranker requires a value.') };
  const name = nameRaw?.trim() ?? '';
  let picked: RecallRerankerPick | null;
  try {
    picked = recallRerankerPick({ infra: cliInfra() }, name);
  } catch (err) {
    // An unknown name throws to the top-level handler, as it did when the lookup sat mid-pipeline.
    return {
      fail: () => {
        throw err;
      },
    };
  }
  if (!picked) return {};
  const { fn } = picked;
  // slice(0, -1) would quietly drop the last candidate rather than fail.
  const topK = intFlagInRange(flags, 'reranker-top-k', { min: 1 });
  if (topK.fail) return { fail: topK.fail };
  return { value: { fn, topK: topK.value ?? picked.defaultTopK } };
}

function parseSalienceFlag(flags: CliFlags): ParsedFlag<number> {
  // A bare --salience-threshold has always read as 1, since Number(true) is 1.
  const raw = flagValueless(flags, 'salience-threshold') ? '1' : stringFlag(flags, 'salience-threshold');
  if (raw === undefined) return {};
  const threshold = Number(raw);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { fail: failLater(`Invalid --salience-threshold: "${raw}". Must be a positive number.`) };
  }
  return { value: threshold };
}

function parseChoiceFlag(flags: CliFlags, name: 'outcome' | 'layer', valid: readonly string[]): ParsedFlag<string> {
  const raw = stringFlag(flags, name);
  if (hasFlag(flags, name) && raw === undefined) {
    return { fail: failLater(`--${name} requires a value. Must be one of: ${valid.join(', ')}.`) };
  }
  const value = raw?.trim() ?? '';
  if (!value) return {};
  if (!valid.includes(value)) {
    return { fail: failLater(`Invalid --${name}: "${value}". Must be one of: ${valid.join(', ')}.`) };
  }
  return { value };
}

/** Parses every flag a ranking stage reads; the first invalid one in pipeline order becomes `error`. */
function parseRecallLateFlags(flags: CliFlags): RecallLateFlags {
  const graphHops = parseHopsFlags(flags);
  const reranker = parseRerankerFlag(flags);
  const salience = parseSalienceFlag(flags);
  const outcome = parseChoiceFlag(flags, 'outcome', ['success', 'failure', 'partial']);
  const layer = parseChoiceFlag(flags, 'layer', Object.values(Layer));
  const staged: ReadonlyArray<readonly [RankStage, (() => never) | undefined]> = [
    ['expand', graphHops.fail],
    ['rerank', reranker.fail],
    ['salience', salience.fail],
    ['outcome', outcome.fail],
    ['layer', layer.fail],
  ];
  let error: LateFlagError | undefined;
  for (const [stage, fail] of staged) {
    if (fail) {
      error = { stage, fail };
      break;
    }
  }
  return {
    graphHops: graphHops.value,
    reranker: reranker.value,
    salienceThreshold: salience.value,
    outcome: outcome.value,
    layer: layer.value,
    error,
  };
}

/** Runs `hippo recall`: the flags name the ranking core and this verb's presenter, `retrieveWithCliCore` ranks and
 * records, then the block prints. */
async function printRecall(
  hippoRoot: string,
  tenantId: string,
  query: string,
  flags: CliFlags,
  callers: CallerState | undefined,
): Promise<void> {
  requireInit(hippoRoot);
  const ctx = cliApiContext(hippoRoot, tenantId, callers);
  const o = parseRecallOptions(ctx, flags);
  const priced = priceRecallEntries(ctx, query, o);
  const { globalRoot } = o.setting;
  const slot: PresentedSlot = {};
  await api.retrieveWithCliCore(
    ctx,
    { query, boost: { goalTag: o.goalTag, sessionId: o.sessionId } },
    {
      rank: rankOptions(query, flags, o, priced),
      // The global store is a second source for this surface alone, and never when it is the store being searched.
      sources: globalRoot !== hippoRoot && priced.globalOn ? cliSecondStore(globalRoot) : undefined,
      note: (line) => printError(line),
      hostSessionId: hostSessionId(),
      lastRecall: ctx.store.lastRecall,
      show: async (rank, planning) => {
        slot.presented = await presentRecall(ctx, query, o, { rank, ...priced }, planning);
        return slot.presented.shown;
      },
    },
  );
  // A late flag is rejected where the ranking halted, after the notes its earlier stages printed.
  o.late.error?.fail();
  if (!slot.presented) throw new Error('recall ranked but presented nothing');
  console.log(slot.presented.text);
}

/** Every flag recall reads, parsed in the order the single-body command checked them. */
function parseRecallOptions(ctx: api.Context, flags: CliFlags) {
  const budget = parseBudgetFlag(flags, DEFAULT_RECALL_BUDGET);
  const limit = parseLimitFlag(flags, 'limit');
  const asJson = boolFlag(flags, 'json');
  const showWhy = boolFlag(flags, 'why');
  const includeSuperseded = boolFlag(flags, 'include-superseded');
  const asOf = parseAsOfFlag(flags);
  // The explicit --scope is the filter input; the detected scope only boosts, so auto-detection never filters.
  const explicitScope = stringFlagOrExit(flags, 'scope') ?? null;
  const setting = recallStoreSetting(ctx, explicitScope || envActiveScope());
  const config = ctx.config;
  const minResults = numberFlag(flags, 'min-results');
  const graphStream = boolFlag(flags, 'graph-stream') ? parseGraphStreamFlags(flags) : undefined;
  const late = parseRecallLateFlags(flags);
  const goalTag = stringFlagOrExit(flags, 'goal') ?? '';
  const sessionId = (stringFlagOrExit(flags, 'session-id') ?? envHippoSessionId() ?? '').trim();
  return {
    budget,
    limit,
    asJson,
    showWhy,
    includeSuperseded,
    asOf,
    setting,
    tenantId: ctx.tenantId,
    explicitScope,
    config,
    minResults,
    graphStream,
    late,
    goalTag,
    sessionId,
    includeContinuity: boolFlag(flags, 'continuity'),
  };
}

type RecallOptions = ReturnType<typeof parseRecallOptions>;

/** Each entry priced as the line it prints, with the source marker `--why` shows. */
function priceRecallEntries(ctx: api.Context, query: string, o: RecallOptions) {
  const origin = recallRowOrigin(ctx, o.setting);
  const isGlobal = origin.isGlobal;
  const entryText = (r: SearchResult): string => recallEntryText(r, query, o.showWhy, isGlobal(r));
  const printCost = (r: SearchResult): number => printedTokens(entryText(r));
  return { globalOn: origin.globalOn, isGlobal, entryText, printCost };
}

type PricedEntries = ReturnType<typeof priceRecallEntries>;

/** The ranking core's options; a late flag error halts it before the stage that reads the flag. */
function rankOptions(
  query: string,
  flags: CliFlags,
  o: RecallOptions,
  priced: PricedEntries,
): api.CliCoreRecall['rank'] {
  // Engines spend the budget on the text each result prints as, less the header, so selection and print agree.
  const entryBudget = Math.max(0, o.budget - printedTokens(recallHeading(o.budget, o.budget, query)));
  return {
    budget: entryBudget,
    cost: priced.printCost,
    window: { limit: o.limit },
    why: o.showWhy,
    includeSuperseded: o.includeSuperseded,
    asOf: o.asOf,
    explicitScope: o.explicitScope,
    activeScope: o.setting.activeScope,
    search: {
      ...engineFlags(flags, o.config),
      multihop: boolFlag(flags, 'multihop') || o.config.multihop.enabled,
      graphStream: o.graphStream,
      minResults: o.minResults,
      explain: false,
    },
    graphHops: o.late.graphHops,
    evcAdaptive: boolFlag(flags, 'evc-adaptive'),
    filterConflicts: boolFlag(flags, 'filter-conflicts'),
    valueAware: boolFlag(flags, 'value-aware'),
    rerankUtility: boolFlag(flags, 'rerank-utility'),
    reranker: o.late.reranker,
    salienceThreshold: o.late.salienceThreshold,
    outcome: o.late.outcome,
    layer: o.late.layer,
    haltBefore: o.late.error?.stage,
  };
}

interface RankedRecall extends PricedEntries {
  readonly rank: RankRecallResult;
}

/** Each pipeline computes its hints over the list it returns, so they follow the list as it shrinks. */
function recallHinter(ctx: api.Context, query: string, o: RecallOptions, rank: RankedRecall['rank']) {
  const { tenantId, sessionId } = o;
  // HIPPO_ANCHORING=off and HIPPO_AVAILABILITY=off skip the work entirely.
  const anchorRing = sessionRing({ config: ctx.config, tenantId, callers: ctx.callers }, 'cli', sessionId);
  const queryHash = hashQueryText(query);
  const pool = availabilityPool(ctx.config, () => [...rank.localEntries, ...rank.globalEntries]);
  const hintsFor = (list: SearchResult[], held: number) => {
    const { anchoring, availability } = detectRecallHints({ list, pool, anchorRing, queryHash });
    const summary = suppressionSummary(
      {
        // The total includes graph-surfaced rows, so total == preRank + byBudget + returned holds for callers.
        totalCandidates: rank.totalCandidates + rank.graphAdded,
        droppedPreRank: rank.droppedPreRank + held,
        droppedByBudget: Math.max(0, rank.totalCandidates + rank.graphAdded - rank.droppedPreRank - held - list.length),
        summarySubstitutionsAdded: 0,
        freshTailAdded: 0,
      },
      anchoring,
    );
    return { anchoring, availability, summary };
  };
  return { anchorRing, hintsFor };
}

type RecallHints = ReturnType<ReturnType<typeof recallHinter>['hintsFor']>;

interface RecallRenderView {
  readonly query: string;
  readonly showWhy: boolean;
  readonly showPlan: boolean;
  readonly planText: string | null;
  readonly hasContinuity: boolean;
  readonly continuity: api.ContinuityBlock;
  readonly entryText: (r: SearchResult) => string;
}

function renderRecallBlock(list: SearchResult[], hints: RecallHints, view: RecallRenderView): string {
  const { query, showWhy, showPlan, planText, hasContinuity, entryText } = view;
  const { activeSnapshot, sessionHandoff, recentSessionEvents } = view.continuity;
  const continuity = continuityTexts(activeSnapshot, sessionHandoff, recentSessionEvents);
  // The hint still prints when nothing matched, so the agent sees its track record.
  const plan = showPlan && planText !== null ? [planText, ''] : [];
  return settleTokens((t) => {
    if (list.length === 0) {
      const none = hasContinuity ? `(no memories matched "${query}")` : `No memories found for: ${query}`;
      return [...plan, ...(hasContinuity ? continuity : []), none].join('\n');
    }
    // Anchoring is the stronger pull, so it prints first; the Cutoff line sits above the list, where a reader sees it.
    const lines = [...continuity];
    if (hints.anchoring) lines.push(`[anchored_on: ${hints.anchoring.memoryId}] ${hints.anchoring.summary}`, '');
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

/** Pays the continuity sections in print order after the header; one that does not fit is dropped. */
function payContinuity(loaded: api.ContinuityBlock, sectionBudget: number) {
  let { activeSnapshot, sessionHandoff, recentSessionEvents } = loaded;
  const { pays, left } = tokenPurse(sectionBudget);
  if (activeSnapshot && !pays(printedTokens(snapshotText(activeSnapshot)))) activeSnapshot = null;
  if (sessionHandoff && !pays(printedTokens(handoffText(sessionHandoff)))) sessionHandoff = null;
  if (recentSessionEvents.length > 0 && !pays(printedTokens(sessionTrailText(recentSessionEvents)))) {
    recentSessionEvents = [];
  }
  const continuity: api.ContinuityBlock = { activeSnapshot, sessionHandoff, recentSessionEvents };
  return { continuity, continuityTokens: sectionBudget - left() };
}

/** Drops the lowest-ranked entry until the whole block, hints and header included, fits the budget. */
function renderWithinBudget(
  fitted: SearchResult[],
  hintsFor: (list: SearchResult[], held: number) => RecallHints,
  view: RecallRenderView,
  floor: number,
  budget: number,
) {
  // Copies go after every cut, so a merged row the budget drops never hides its sources.
  const render = (kept: number) => {
    const results = dropHeldCopies(fitted.slice(0, kept), (r) => r.entry);
    const hints = hintsFor(results, kept - results.length);
    return { results, hints, recallText: renderRecallBlock(results, hints, view) };
  };
  return shrinkToFit(fitted.length, floor, budget, render, (r) => r.recallText);
}

interface FitRecallBlockOptions {
  ctx: api.Context;
  query: string;
  recall: RecallOptions;
  ranked: RankedRecall;
  loaded: api.ContinuityBlock;
  planning: PlanningFallacyOutput;
}

/** Pays the continuity sections and the plan hint first, then fits the memories into what is left. */
function fitRecallBlock(options: FitRecallBlockOptions) {
  const { ctx, query, recall: o, ranked, loaded, planning } = options;
  const { budget } = o;
  // Sections print ahead of the memories, so they are paid first, after the header; one that does not fit is dropped.
  const sectionBudget = budget - printedTokens(recallHeading(budget, budget, query));
  const { continuity, continuityTokens } = payContinuity(loaded, sectionBudget);
  let left = sectionBudget - continuityTokens;
  const { activeSnapshot, sessionHandoff, recentSessionEvents } = continuity;
  const hasContinuity = activeSnapshot !== null || sessionHandoff !== null || recentSessionEvents.length > 0;

  // The baserate hint depends on the query alone, so `retrieveWithCliCore` evaluates it and this only prices the line.
  const planText = planningLine(planning);
  const planTokens = planText === null ? 0 : printedTokens(`${planText}\n`);
  const showPlan = planText !== null && planTokens <= left;
  if (showPlan) left -= planTokens;
  const cmdPlanningFallacyHint = showPlan ? (planning.hint ?? null) : null;
  const cmdPlanningFallacyWatching = showPlan ? (planning.watching ?? null) : null;

  // The first --min-results are kept whatever they cost (the documented exception); the rest skip and continue.
  const floor = o.minResults ?? 1;
  const fitted = fitRecallRows(ranked.rank.results, left, floor, ranked.printCost);
  const { anchorRing, hintsFor } = recallHinter(ctx, query, o, ranked.rank);
  const view: RecallRenderView = {
    query,
    showWhy: o.showWhy,
    showPlan,
    planText,
    hasContinuity,
    continuity,
    entryText: ranked.entryText,
  };
  const { results, hints, recallText } = renderWithinBudget(fitted, hintsFor, view, floor, budget);
  return {
    results,
    hints,
    recallText,
    continuity,
    continuityTokens,
    cmdPlanningFallacyHint,
    cmdPlanningFallacyWatching,
    anchorRing,
  };
}

type FittedRecall = ReturnType<typeof fitRecallBlock>;

/** The presenter `retrieveWithCliCore` calls once ranking ends: fits and renders the block, and names the rows and hint
 * rows to record. */
async function presentRecall(
  ctx: api.Context,
  query: string,
  o: RecallOptions,
  ranked: RankedRecall,
  planning: PlanningFallacyOutput,
) {
  // Loaded before the zero-result branch, so a no-match query with live continuity still returns a resume packet.
  const loaded = await loadScopedContinuity(ctx, o.setting, o.includeContinuity);
  const fit = fitRecallBlock({ ctx, query, recall: o, ranked, loaded, planning });
  const { results, hints } = fit;
  const text = recallOutput(query, o, fit, ranked.isGlobal);
  const audit = shownRecallRows(
    ctx.config,
    { tenantId: o.tenantId, actor: CLI_ACTOR },
    {
      query,
      sessionId: o.sessionId,
      topId: results[0]?.entry.id ?? null,
      anchoring: hints.anchoring,
      availability: hints.availability,
    },
  );
  // The token ledger books the text this recall prints, on whichever exit it takes; the ring keeps the hint the final
  // detect made.
  return { text, shown: { results, audit, tokens: estimateTokens(text), anchoredOn: hints.anchoring?.memoryId } };
}

type PresentedRecall = Awaited<ReturnType<typeof presentRecall>>;

/** Where the presenter parks what it built; a `let` it assigned would read as never-assigned after the await. */
interface PresentedSlot {
  presented?: PresentedRecall;
}

/** What this recall prints: the JSON object, or the fitted block. */
function recallOutput(
  query: string,
  o: RecallOptions,
  fit: FittedRecall,
  isGlobal: (r: SearchResult) => boolean,
): string {
  const { asJson, includeContinuity } = o;
  const { results, recallText } = fit;
  if (results.length === 0) {
    // HTTP and MCP surface the hint whatever matched, so the zero-result JSON keeps it for parity.
    return asJson
      ? JSON.stringify({ query, results: [], total: 0, ...recallJsonTail(fit, includeContinuity) })
      : recallText;
  }
  if (!asJson) return recallText;
  const output = results.map((r) => recallJsonRow(r, query, o.showWhy, isGlobal(r)));
  return JSON.stringify({
    query,
    budget: o.budget,
    results: output,
    total: output.length,
    ...recallJsonTail(fit, includeContinuity),
  });
}

/** The keys are set in the order the JSON prints them. */
interface RecallJsonTail {
  suppressionSummary: FittedRecall['hints']['summary'];
  planningFallacyHint?: NonNullable<FittedRecall['cmdPlanningFallacyHint']>;
  planningFallacyWatching?: NonNullable<FittedRecall['cmdPlanningFallacyWatching']>;
  anchoringHint?: NonNullable<FittedRecall['hints']['anchoring']>;
  availabilityHint?: NonNullable<FittedRecall['hints']['availability']>;
  continuity?: ContinuityBlockJson;
  continuityTokens?: number;
}

/** The JSON keys after the result list: suppression summary, any bias hints, then continuity when asked for. */
function recallJsonTail(fit: FittedRecall, includeContinuity: boolean | undefined): RecallJsonTail {
  const { cmdPlanningFallacyHint, cmdPlanningFallacyWatching, continuityTokens } = fit;
  const { anchoring: cmdAnchoringHint, availability: cmdAvailabilityHint, summary: cmdSuppressionSummary } = fit.hints;
  const tail: RecallJsonTail = { suppressionSummary: cmdSuppressionSummary };
  if (cmdPlanningFallacyHint) tail.planningFallacyHint = cmdPlanningFallacyHint;
  if (cmdPlanningFallacyWatching) tail.planningFallacyWatching = cmdPlanningFallacyWatching;
  if (cmdAnchoringHint) tail.anchoringHint = cmdAnchoringHint;
  if (cmdAvailabilityHint) tail.availabilityHint = cmdAvailabilityHint;
  if (includeContinuity) {
    tail.continuity = continuityJson(fit.continuity);
    tail.continuityTokens = continuityTokens;
  }
  return tail;
}

export async function handleRecall({ hippoRoot, tenantId, args, flags, callers }: CommandContext): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    fail('Please provide a search query.');
  }
  await printRecall(hookStoreRoot(hippoRoot), tenantId, query, flags, callers);
}
