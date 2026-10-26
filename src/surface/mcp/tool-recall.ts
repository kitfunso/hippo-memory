// The recall an agent's tool prints: the ranked list cut to the caller's token budget, with the hints and the Cutoff
// block that describe that list.

import type { SearchResult } from '../../base/rank/search-types.js';
import { dropHeldCopies, duplicateKey, storedTextKeys } from '../../base/util/same-text.js';
import { estimateTokens, tokenPurse } from '../../base/util/token-text.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';
import type { CallerProject } from '../../api/prompt-hook.js';
import type { Context } from '../../api/types.js';
import {
  callerOf,
  hashQueryText,
  RECALL_RECORDING,
  sessionRing,
  shownRecallRows,
  type HintConfig,
  type RingBuffer,
} from '../../api/recall/finish.js';
import { retrieveRanking } from '../../api/recall/recall.js';
import { fitRecall } from '../../api/recall/rows.js';
import {
  availabilityPool,
  cutoffClauses,
  detectRecallHints,
  suppressionSummary,
  type SuppressionCounts,
} from '../render/recall-text.js';
import type { SharedRecallOptions } from '../../api/recall/request.js';
import {
  formatContinuityBlock,
  formatMemories,
  memoryCost,
  memoriesReserve,
  planningSection,
  tailSection,
  type RenderedRecall,
  type RenderSlot,
} from './tool-text.js';
import type { RecallResultItem, RecallSuppressionSummary, ShowRanking } from '../../api/recall/types.js';

/**
 * Builds the presenter that renders the list the tool shows, parks the render in `out` and hands back its hint rows.
 */
interface RecallPresenterOptions {
  readonly config: HintConfig;
  readonly includeContinuity: boolean;
  readonly anchorRing: RingBuffer | null;
  readonly queryHash: number;
  readonly out: RenderSlot;
  readonly hintRows: (rendered: RenderedRecall) => AppendAuditOptions[];
}

// Candidate pool the tool ranks before the token budget trims what is shown.
const TOOL_RECALL_LIMIT = 50;

function biasHintSections(
  anchoring: RenderedRecall['anchoring'],
  availability: RenderedRecall['availability'],
): string {
  let text = anchoring
    ? `## Anchoring hint\n${anchoring.summary}\n[anchored_on: ${anchoring.memoryId}]\n\n---\n\n`
    : '';
  if (availability) text += `## Availability bias\n${availability.summary}\n\n---\n\n`;
  return text;
}

function cutoffSection(s: RecallSuppressionSummary, shown: number): string {
  const clauses = cutoffClauses(s);
  if (clauses.length === 0) return '';
  return `## Cutoff
Showing ${shown} of ${s.totalCandidates} candidates; ${clauses.join('; ')}.

---

`;
}

interface SuppressionInputs {
  readonly poolSize: number;
  readonly droppedByScope: number;
  readonly cut: SearchResult[];
  readonly list: SearchResult[];
  readonly tail: ReadonlyArray<{ isSummary?: boolean; isFreshTail?: boolean }>;
}

function suppressionCounts(i: SuppressionInputs): SuppressionCounts {
  return {
    totalCandidates: i.poolSize + i.droppedByScope,
    droppedPreRank: i.droppedByScope + i.cut.length - i.list.length, // the bucket CLI and API recall use for copies
    droppedByBudget: Math.max(0, i.poolSize - i.cut.length), // an upper bound: rows that never matched count too
    summarySubstitutionsAdded: i.tail.filter((r) => r.isSummary).length,
    freshTailAdded: i.tail.filter((r) => r.isFreshTail && !r.isSummary).length,
  };
}

/** The window band's fresh-tail and summary rows that the shown list holds neither by id nor by text. */
function unshownTail(list: SearchResult[], tailRows: RecallResultItem[]): RecallResultItem[] {
  const shownIds = new Set(list.map((r) => r.entry.id));
  const shownKeys = storedTextKeys(list.map((r) => r.entry));
  const unshown = tailRows.filter((r) => !shownIds.has(r.id) && !shownKeys.has(duplicateKey(r.content)));
  return dropHeldCopies(unshown, (r) => r);
}

function recallPresenter(budget: number, options: RecallPresenterOptions): ShowRanking {
  const { config, includeContinuity, anchorRing, queryHash, out, hintRows } = options;
  return ({ ranked, pool, droppedByScope }, apiResult) => {
    // Sections are paid in print order, ahead of the memories and after the heading; one that does not fit is dropped
    // whole.
    const purse = tokenPurse(budget - memoriesReserve(budget));
    const pays = (piece: string): boolean => purse.pays(estimateTokens(piece));
    const hintPool = availabilityPool(config, () => pool);
    const planPiece = planningSection(apiResult);
    const showPlan = planPiece !== '' && pays(planPiece);
    const tailRows = apiResult.results.filter((r) => r.isFreshTail || r.isSummary);
    const showTail = tailRows.length > 0 && pays(tailSection(tailRows));
    const continuityPiece =
      includeContinuity && apiResult.continuity ? `\n\n${formatContinuityBlock(apiResult.continuity)}` : '';
    const showContinuity = continuityPiece !== '' && pays(continuityPiece);

    // The hints and Cutoff block describe the list the tool shows, not the window band in apiResult.
    const render = (cut: SearchResult[]): RenderedRecall => {
      // After every cut, so a merged row cut here never hides its sources.
      const list = dropHeldCopies(cut, (r) => r.entry);
      const { anchoring, availability } = detectRecallHints({ list, pool: hintPool, anchorRing, queryHash });
      const tail = showTail ? unshownTail(list, tailRows) : [];
      const counts = suppressionCounts({ poolSize: pool.length, droppedByScope, cut, list, tail });
      const s = suppressionSummary(counts, anchoring);
      // Anchoring is the stronger pull, so it prints first; the Cutoff block sits above the list, where the agent reads
      // it.
      let text = biasHintSections(anchoring, availability);
      if (showPlan) text += planPiece;
      text += cutoffSection(s, list.length);
      // The window band's fresh-tail and summary rows follow the ranked list, or the tool's fields go unanswered.
      text += formatMemories(list) + tailSection(tail) + (showContinuity ? continuityPiece : '');
      return { anchoring, availability, text, list };
    };
    const fit = { room: Math.max(0, purse.left()), budget, floor: 1, cost: memoryCost };
    const rendered = fitRecall(ranked, { ...fit, render, textOf: (r) => r.text });
    out.rendered = rendered;
    return {
      ids: rendered.list.map((r) => r.entry.id),
      audit: hintRows(rendered),
      anchoredOn: rendered.anchoring?.memoryId,
      tokens: estimateTokens(rendered.text),
    };
  };
}

export interface ToolRecallRequest {
  readonly opts: SharedRecallOptions;
  /** The caller's token budget; the store's defaultBudget when absent. */
  readonly budget: number | undefined;
  /** The caller's project on a shared store, which keeps the list to its rows and user-global ones. */
  readonly project: CallerProject | undefined;
}

/** hippo_recall's text. The tool keeps its own band size and search mode, and a RecallContractError reaches the caller
 * raw, as mcp-recall-fresh-tail-policy.test.ts pins. */
export async function toolRecallText(ctx: Context, req: ToolRecallRequest): Promise<string> {
  const { opts, project } = req;
  const {
    query,
    window: { includeContinuity },
    boost: { sessionId },
  } = opts;
  const budget = req.budget ?? ctx.config.defaultBudget;
  const anchorRing = sessionRing(ctx, 'mcp', sessionId);
  const who = callerOf(ctx);
  const queryHash = hashQueryText(query);
  const out: RenderSlot = {};
  await retrieveRanking(
    ctx,
    {
      ...opts,
      window: { ...opts.window, limit: TOOL_RECALL_LIMIT },
      mode: ctx.config.physics?.enabled !== false ? 'physics' : 'hybrid',
      filter: { ...opts.filter, keepHeldCopies: true, project },
      // The hint is computed below over the list the tool shows; the window's copy would emit its audit row twice.
      hints: { suppressAvailabilityHint: true },
      trace: { recordAs: RECALL_RECORDING.mcp },
    },
    recallPresenter(budget, {
      config: ctx.config,
      includeContinuity,
      anchorRing,
      queryHash,
      out,
      hintRows: ({ list, anchoring, availability }) =>
        shownRecallRows(ctx.config, who, {
          query,
          sessionId,
          topId: list[0]?.entry.id ?? null,
          anchoring,
          availability,
        }),
    }),
  );
  const { rendered } = out;
  if (!rendered) throw new Error('hippo_recall: api.retrieveRanking returned without calling its presenter');
  return rendered.text;
}
