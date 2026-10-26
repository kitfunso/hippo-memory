// The `hippo recall` verb; main() loads it lazily from the command table.

import { envActiveScope, envHippoSessionId } from '../../base/util/env.js';
import type { CallerState } from '../../api/callers.js';
import { Layer } from '../../base/memory/entry.js';
import { DEFAULT_MIN_RESULTS, DEFAULT_RECALL_BUDGET, type SearchResult } from '../../base/rank/search-types.js';
import { estimateTokens, tokenPurse } from '../../base/util/token-text.js';
import { dropHeldCopies } from '../../base/util/same-text.js';
import * as api from '../../api/index.js';
import type {
  PlanningFallacyHint,
  PlanningFallacyOutput,
  PlanningFallacyWatching,
} from '../../base/records/planning-fallacy.js';
import type { HippoConfig } from '../../base/config/config.js';
import { hashQueryText, sessionRing, type AnchoringHint } from '../../api/recall/finish.js';
import type { AvailabilityHint } from '../../api/availability.js';
import { handoffText, printedTokens, sessionTrailText, settleTokens, snapshotText } from '../../api/context-render.js';
import type {
  RankRecallResult,
  RankRecallStages,
  RecallGraphHops,
  RecallGraphStream,
  RecallReranker,
} from '../../api/recall/pipeline.js';
import {
  availabilityPool,
  cutoffClauses,
  detectRecallHints,
  suppressionSummary,
  type RecallHints,
} from '../render/recall-text.js';
import {
  recallRowOrigin,
  recallRerankerPick,
  recallStoreSetting,
  DEFAULT_MAX_NEIGHBORS,
  fitRecall,
  loadScopedContinuity,
  MAX_HOPS,
  recallJsonRow,
  type RecallRerankerPick,
  type RecallRowOrigin,
  type RecallStoreSetting,
} from '../../api/recall/rows.js';
import { cliApiContext, cliInfra, cliSecondStore } from './api-context.js';
import { printError } from './output.js';
import {
  type CliFlags,
  type CommandContext,
  type EngineFlags,
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
import { MAX_NEIGHBORS_FLAG } from './flag-defaults.js';

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

type RecallStageFlags = Pick<RankRecallStages, 'graphHops' | 'reranker' | 'salienceThreshold' | 'outcome' | 'layer'>;

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
    // Deferred like the other stage flags, so a bad flag earlier in pipeline order fails first.
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

/** Parses every flag a ranking stage reads and fails on the first invalid one in pipeline order. */
function parseStageFlags(flags: CliFlags): RecallStageFlags {
  const graphHops = parseHopsFlags(flags);
  const reranker = parseRerankerFlag(flags);
  const salience = parseSalienceFlag(flags);
  const outcome = parseChoiceFlag(flags, 'outcome', ['success', 'failure', 'partial']);
  const layer = parseChoiceFlag(flags, 'layer', Object.values(Layer));
  for (const flag of [graphHops, reranker, salience, outcome, layer]) flag.fail?.();
  return {
    graphHops: graphHops.value,
    reranker: reranker.value,
    salienceThreshold: salience.value,
    outcome: outcome.value,
    layer: layer.value,
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
  const parsed = parseRecallFlags(ctx, flags);
  const priced = priceRecallEntries(ctx, query, parsed);
  const { globalRoot } = parsed.setting;
  const slot: PresentedSlot = {};
  await api.retrieveWithCliCore(
    ctx,
    { query, boost: { goalTag: parsed.goalTag, sessionId: parsed.sessionId } },
    {
      rank: rankOptions(query, flags, parsed, priced),
      // The global store is a second source for this surface alone, and never when it is the store being searched.
      sources: globalRoot !== hippoRoot && priced.globalOn ? cliSecondStore(globalRoot) : undefined,
      note: (line) => printError(line),
      hostSessionId: hostSessionId(),
      lastRecall: ctx.store.lastRecall,
      show: async (rank, planning) => {
        slot.presented = await presentRecall(ctx, query, parsed, { rank, ...priced }, planning);
        return slot.presented.shown;
      },
    },
  );
  if (!slot.presented) throw new Error('recall ranked but presented nothing');
  console.log(slot.presented.text);
}

/** What `hippo recall` reads: its flags, the store setting they pick, the tenant and the store's config. */
export interface ParsedRecallFlags {
  readonly budget: number;
  readonly limit: number;
  readonly asJson: boolean;
  readonly showWhy: boolean;
  readonly includeSuperseded: boolean;
  readonly asOf: string | undefined;
  readonly setting: RecallStoreSetting;
  readonly tenantId: string;
  readonly explicitScope: string | null;
  readonly config: HippoConfig;
  readonly minResults: number | undefined;
  readonly graphStream: RecallGraphStream | undefined;
  readonly goalTag: string;
  readonly sessionId: string;
  readonly engine: EngineFlags;
  readonly stages: RecallStageFlags;
  readonly includeContinuity: boolean;
}

/** Every flag recall reads, parsed in a fixed order because the first invalid flag decides which error prints; all
 * of them are checked before ranking starts. */
function parseRecallFlags(ctx: api.Context, flags: CliFlags): ParsedRecallFlags {
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
  const goalTag = stringFlagOrExit(flags, 'goal') ?? '';
  const sessionId = (stringFlagOrExit(flags, 'session-id') ?? envHippoSessionId() ?? '').trim();
  const engine = engineFlags(flags, config);
  const stages = parseStageFlags(flags);
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
    goalTag,
    sessionId,
    engine,
    stages,
    includeContinuity: boolFlag(flags, 'continuity'),
  };
}

/** Each entry priced as the line it prints, with the source marker `--why` shows. */
export interface PricedEntries extends RecallRowOrigin {
  readonly entryText: (r: SearchResult) => string;
  readonly printCost: (r: SearchResult) => number;
}

function priceRecallEntries(ctx: api.Context, query: string, parsed: ParsedRecallFlags): PricedEntries {
  const origin = recallRowOrigin(ctx, parsed.setting);
  const isGlobal = origin.isGlobal;
  const now = ctx.infra.clock();
  const entryText = (r: SearchResult): string => recallEntryText(r, query, parsed.showWhy, isGlobal(r), now);
  const printCost = (r: SearchResult): number => printedTokens(entryText(r));
  return { globalOn: origin.globalOn, isGlobal, entryText, printCost };
}

/** The ranking core's options, from flags already checked. */
function rankOptions(
  query: string,
  flags: CliFlags,
  parsed: ParsedRecallFlags,
  priced: PricedEntries,
): api.CliCoreRecall['rank'] {
  // Engines spend the budget on the text each result prints as, less the header, so selection and print agree.
  const entryBudget = Math.max(0, parsed.budget - printedTokens(recallHeading(parsed.budget, parsed.budget, query)));
  return {
    budget: entryBudget,
    cost: priced.printCost,
    window: { limit: parsed.limit },
    why: parsed.showWhy,
    includeSuperseded: parsed.includeSuperseded,
    asOf: parsed.asOf,
    explicitScope: parsed.explicitScope,
    activeScope: parsed.setting.activeScope,
    search: {
      ...parsed.engine,
      multihop: boolFlag(flags, 'multihop') || parsed.config.multihop.enabled,
      graphStream: parsed.graphStream,
      minResults: parsed.minResults,
      explain: false,
    },
    graphHops: parsed.stages.graphHops,
    evcAdaptive: boolFlag(flags, 'evc-adaptive'),
    filterConflicts: boolFlag(flags, 'filter-conflicts'),
    valueAware: boolFlag(flags, 'value-aware'),
    rerankUtility: boolFlag(flags, 'rerank-utility'),
    reranker: parsed.stages.reranker,
    salienceThreshold: parsed.stages.salienceThreshold,
    outcome: parsed.stages.outcome,
    layer: parsed.stages.layer,
  };
}

interface RankedRecall extends PricedEntries {
  readonly rank: RankRecallResult;
}

/** The bias hints over one shown list, and the cutoff counts `--why` prints. */
export interface RecallBlockHints extends RecallHints {
  readonly summary: api.RecallSuppressionSummary;
}

/** Hints for a list that dropped `held` merged copies. */
type HintsFor = (list: SearchResult[], held: number) => RecallBlockHints;

/** Each pipeline computes its hints over the list it returns, so they follow the list as it shrinks. */
function recallHinter(ctx: api.Context, query: string, parsed: ParsedRecallFlags, rank: RankRecallResult): HintsFor {
  const { tenantId, sessionId } = parsed;
  // HIPPO_ANCHORING=off and HIPPO_AVAILABILITY=off skip the work entirely.
  const anchorRing = sessionRing({ config: ctx.config, tenantId, callers: ctx.callers }, 'cli', sessionId);
  const queryHash = hashQueryText(query);
  const pool = availabilityPool(ctx.config, () => [...rank.localEntries, ...rank.globalEntries]);
  return (list, held) => {
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

function renderRecallBlock(list: SearchResult[], hints: RecallBlockHints, view: RecallRenderView): string {
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

/** One rendering of the block: the rows it lists, their hints and the text. */
interface RenderedRecall {
  readonly results: SearchResult[];
  readonly hints: RecallBlockHints;
  readonly recallText: string;
}

/** The block over one cut of the ranked rows. */
function renderRows(rows: SearchResult[], hintsFor: HintsFor, view: RecallRenderView): RenderedRecall {
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

/** Pays the continuity sections and the plan hint first, then fits the memories into what is left. */
function fitRecallBlock(options: FitRecallBlockOptions): FittedRecall {
  const { ctx, query, parsed, ranked, loaded, planning } = options;
  const { budget } = parsed;
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
  const planningFallacyHint = showPlan ? (planning.hint ?? null) : null;
  const planningFallacyWatching = showPlan ? (planning.watching ?? null) : null;

  const hintsFor = recallHinter(ctx, query, parsed, ranked.rank);
  const view: RecallRenderView = {
    query,
    showWhy: parsed.showWhy,
    showPlan,
    planText,
    hasContinuity,
    continuity,
    entryText: ranked.entryText,
  };
  const { results, hints, recallText } = fitRecall(ranked.rank.results, {
    room: left,
    budget,
    // The first --min-results are kept whatever they cost (the documented exception); the rest skip and continue.
    floor: parsed.minResults ?? DEFAULT_MIN_RESULTS,
    cost: ranked.printCost,
    render: (rows) => renderRows(rows, hintsFor, view),
    textOf: (r) => r.recallText,
  });
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

/** The printed block and what `retrieveWithCliCore` records of it. */
export interface PresentedRecall {
  readonly text: string;
  readonly shown: api.ShownCliCore;
}

/** The presenter `retrieveWithCliCore` calls once ranking ends: fits and renders the block, and names the rows shown
 * and the hints over them. */
async function presentRecall(
  ctx: api.Context,
  query: string,
  parsed: ParsedRecallFlags,
  ranked: RankedRecall,
  planning: PlanningFallacyOutput,
): Promise<PresentedRecall> {
  // Loaded before the zero-result branch, so a no-match query with live continuity still returns a resume packet.
  const loaded = await loadScopedContinuity(ctx, parsed.setting, parsed.includeContinuity);
  const fit = fitRecallBlock({ ctx, query, parsed, ranked, loaded, planning });
  const { results, hints } = fit;
  const text = recallOutput(query, parsed, fit, ranked.isGlobal, ctx.infra.clock());
  // The token ledger books the text this recall prints, on whichever exit it takes; the ring keeps the hint the final
  // detect made.
  return { text, shown: { results, hints, tokens: estimateTokens(text) } };
}

/** Where the presenter parks what it built; a `let` it assigned would read as never-assigned after the await. */
interface PresentedSlot {
  presented?: PresentedRecall;
}

/** What this recall prints: the JSON object, or the fitted block. */
function recallOutput(
  query: string,
  parsed: ParsedRecallFlags,
  fit: FittedRecall,
  isGlobal: (r: SearchResult) => boolean,
  now: Date,
): string {
  const { asJson, includeContinuity } = parsed;
  const { results, recallText } = fit;
  if (results.length === 0) {
    // HTTP and MCP surface the hint whatever matched, so the zero-result JSON keeps it for parity.
    return asJson
      ? JSON.stringify({ query, results: [], total: 0, ...recallJsonTail(fit, includeContinuity) })
      : recallText;
  }
  if (!asJson) return recallText;
  const output = results.map((r) => recallJsonRow(r, query, parsed.showWhy, isGlobal(r), now));
  return JSON.stringify({
    query,
    budget: parsed.budget,
    results: output,
    total: output.length,
    ...recallJsonTail(fit, includeContinuity),
  });
}

/** The keys are set in the order the JSON prints them. */
interface RecallJsonTail {
  suppressionSummary: api.RecallSuppressionSummary;
  planningFallacyHint?: PlanningFallacyHint;
  planningFallacyWatching?: PlanningFallacyWatching;
  anchoringHint?: AnchoringHint;
  availabilityHint?: AvailabilityHint;
  continuity?: ContinuityBlockJson;
  continuityTokens?: number;
}

/** The JSON keys after the result list: suppression summary, any bias hints, then continuity when asked for. */
function recallJsonTail(fit: FittedRecall, includeContinuity: boolean | undefined): RecallJsonTail {
  const { planningFallacyHint, planningFallacyWatching, continuityTokens } = fit;
  const { anchoring, availability, summary } = fit.hints;
  const tail: RecallJsonTail = { suppressionSummary: summary };
  if (planningFallacyHint) tail.planningFallacyHint = planningFallacyHint;
  if (planningFallacyWatching) tail.planningFallacyWatching = planningFallacyWatching;
  if (anchoring) tail.anchoringHint = anchoring;
  if (availability) tail.availabilityHint = availability;
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
