// The `hippo recall` verb: run the recall, then print or serialise what it found; main() loads it
// lazily from the command table.

import type { CallerState } from '../../api/callers.js';
import { type SearchResult } from '../../base/rank/search-types.js';
import { estimateTokens } from '../../base/util/token-text.js';
import * as api from '../../api/index.js';
import type {
  PlanningFallacyHint,
  PlanningFallacyOutput,
  PlanningFallacyWatching,
} from '../../base/records/planning-fallacy.js';
import { type AnchoringHint } from '../../api/recall/anchoring.js';
import type { AvailabilityHint } from '../../api/availability.js';
import { printedTokens } from '../../api/context/context-render.js';
import { loadScopedContinuity, recallJsonRow } from '../../api/recall/rows.js';
import { printError } from './output.js';
import { type CliFlags, type CommandContext, boolFlag } from './flag-values.js';
import { requireInit } from './shared.js';
import { recallHeading } from './print.js';
import { continuityJson, type ContinuityBlockJson } from '../../base/session/continuity-json.js';
import { hostSessionId, hookStoreRoot } from './hook-runtime.js';
import { fail } from './exit.js';
import {
  fitRecallBlock,
  priceRecallEntries,
  type FittedRecall,
  type PricedEntries,
  type RankedRecall,
} from './recall-block.js';
import { parseRecallFlags, type ParsedRecallFlags } from './recall-flags.js';
import type { CliCommand } from './api-context.js';

/** Runs `hippo recall`: the flags name the ranking core and this verb's presenter,
 * `retrieveWithCliCore` ranks and records, then the block prints. */
interface PrintRecallOptions {
  readonly cli: CliCommand;
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly query: string;
  readonly flags: CliFlags;
  readonly callers: CallerState | undefined;
}

async function printRecall({
  cli,
  hippoRoot,
  tenantId,
  query,
  flags,
  callers,
}: PrintRecallOptions): Promise<void> {
  requireInit(hippoRoot);
  const ctx = cli.apiContext(hippoRoot, tenantId, callers);
  const parsed = parseRecallFlags(ctx, flags);
  const priced = priceRecallEntries(ctx, query, parsed);
  const { globalRoot } = parsed.setting;
  const slot: PresentedSlot = {};
  await api.retrieveWithCliCore(
    ctx,
    { query, boost: { goalTag: parsed.goalTag, sessionId: parsed.sessionId } },
    {
      rank: rankOptions(query, flags, parsed, priced),
      // The global store is a second source for this surface alone, and never when it is the store
      // being searched.
      sources:
        globalRoot !== hippoRoot && priced.globalOn ? cli.secondStore(globalRoot) : undefined,
      note: (line) => printError(line),
      hostSessionId: hostSessionId(),
      show: async (rank, planning) => {
        slot.presented = await presentRecall(ctx, {
          query,
          parsed,
          ranked: { rank, ...priced },
          planning,
        });
        return slot.presented.shown;
      },
    },
  );
  if (!slot.presented) throw new Error('recall ranked but presented nothing');
  console.log(slot.presented.text);
}

/** The ranking core's options, from flags already checked. */
function rankOptions(
  query: string,
  flags: CliFlags,
  parsed: ParsedRecallFlags,
  priced: PricedEntries,
): api.CliCoreRecall['rank'] {
  // Engines spend the budget on the text each result prints as, less the header, so selection and
  // print agree.
  const entryBudget = Math.max(
    0,
    parsed.budget - printedTokens(recallHeading(parsed.budget, parsed.budget, query)),
  );
  return {
    budget: entryBudget,
    cost: priced.printCost,
    limit: parsed.limit,
    why: parsed.showWhy,
    includeSuperseded: parsed.includeSuperseded,
    asOf: parsed.asOf,
    explicitScope: parsed.explicitScope,
    activeScope: parsed.setting.activeScope,
    ...parsed.engine,
    multihop: boolFlag(flags, 'multihop') || parsed.config.multihop.enabled,
    graphStream: parsed.graphStream,
    minResults: parsed.minResults,
    explain: false,
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

/** The printed block and what `retrieveWithCliCore` records of it. */
export interface PresentedRecall {
  readonly text: string;
  readonly shown: api.ShownCliCore;
}

interface PresentRecallOptions {
  readonly query: string;
  readonly parsed: ParsedRecallFlags;
  readonly ranked: RankedRecall;
  readonly planning: PlanningFallacyOutput;
}

/** The presenter `retrieveWithCliCore` calls once ranking ends: fits and renders the block, and
 * names the rows shown and the hints over them. */
async function presentRecall(
  ctx: api.Context,
  { query, parsed, ranked, planning }: PresentRecallOptions,
): Promise<PresentedRecall> {
  // Loaded before the zero-result branch, so a no-match query with live continuity still returns a
  // resume packet.
  const loaded = await loadScopedContinuity(ctx, parsed.setting, parsed.includeContinuity);
  const fit = fitRecallBlock({ ctx, query, parsed, ranked, loaded, planning });
  const { results, hints } = fit;
  const text = recallOutput({
    query,
    parsed,
    fit,
    isGlobal: ranked.isGlobal,
    now: ctx.infra.clock(),
  });
  // The token ledger books the text this recall prints, on whichever exit it takes; the ring keeps
  // the hint the final detect made.
  return { text, shown: { results, hints, tokens: estimateTokens(text) } };
}

/** Where the presenter parks what it built; a `let` it assigned would read as never-assigned
 * after the await. */
interface PresentedSlot {
  presented?: PresentedRecall;
}

interface RecallOutputOptions {
  readonly query: string;
  readonly parsed: ParsedRecallFlags;
  readonly fit: FittedRecall;
  readonly isGlobal: (r: SearchResult) => boolean;
  readonly now: Date;
}

/** What this recall prints: the JSON object, or the fitted block. */
function recallOutput({ query, parsed, fit, isGlobal, now }: RecallOutputOptions): string {
  const { asJson, includeContinuity } = parsed;
  const { results, recallText } = fit;
  if (results.length === 0) {
    // HTTP and MCP surface the hint whatever matched, so the zero-result JSON keeps it for parity.
    return asJson
      ? JSON.stringify({ query, results: [], total: 0, ...recallJsonTail(fit, includeContinuity) })
      : recallText;
  }
  if (!asJson) return recallText;
  const output = results.map((r) =>
    recallJsonRow({ r, query, showWhy: parsed.showWhy, isGlobal: isGlobal(r), now }),
  );
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

/** The JSON keys after the result list: suppression summary, any bias hints, then continuity
 * when asked for. */
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

export async function handleRecall({
  cli,
  hippoRoot,
  tenantId,
  args,
  flags,
  callers,
}: CommandContext): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    fail('Please provide a search query.');
  }
  await printRecall({ cli, hippoRoot: hookStoreRoot(hippoRoot), tenantId, query, flags, callers });
}
