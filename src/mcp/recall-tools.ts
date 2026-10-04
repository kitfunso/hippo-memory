// Read-side tool handlers: hippo_recall, hippo_assemble, hippo_drill and hippo_context.

import * as path from 'path';
import { fitBudget } from '../search/finalize.js';
import type { SearchResult } from '../search/types.js';
import { dropHeldCopies, duplicateKey, storedTextKeys } from '../same-text.js';
import { retrieve as apiRetrieve, drillDown as apiDrillDown, assemble as apiAssemble, getContext as apiGetContext, buildSuppressionSummary, type Context as ApiContext, type RecallOpts } from '../api.js';
import { autoDetectContext } from '../context-auto.js';
import { resolveProjectIdentity } from '../project-identity.js';
import { detectAnchoring, hashQueryText, biasHintEnabled, snapshotRing, type RingBuffer } from '../recall-history.js';
import { detectAvailabilityBias } from '../availability.js';
import { estimateTokens } from '../token-ledger.js';
import { assembleCost, assembleText, drillCost, drillText } from '../context-render.js';
import { mcpActor, type ToolCall } from './protocol.js';
import { lastRecalledIds, resolveClientKey } from './session-state.js';
import {
  formatContinuityBlock,
  formatMemories,
  memoryCost,
  memoriesReserve,
  snapshotPiece,
  handoffPiece,
  trailPiece,
  contextCost,
  tailSection,
  planningSection,
  type RenderedRecall,
  type RenderSlot,
} from './format.js';
import { isJsonString } from '../json.js';
import { parseContextRequest, parseRecallRequest, toolParams } from '../api/recall-request.js';
import { recordShownRecall, sessionRing } from '../api/recall-record.js';

// Named shapes for the optional fields each api.* call only wants to pass
// when the caller actually supplied them. Built via `const extra: T = {};
// if (cond) extra.field = value;` then spread once, unconditionally — keeps
// the same per-field omission semantics as a conditional spread without the
// `...(cond ? { field } : {})` pattern.
interface AssembleExtraOpts {
  budget?: number;
  freshTailCount?: number;
  scope?: string;
}

interface DrillDownExtraOpts {
  limit?: number;
  budget?: number;
  depth?: number;
}

/** Builds the showRanked callback that renders the list MCP shows and parks the render in `out`. */
function recallPresenter(
  budget: number,
  includeContinuity: boolean,
  anchorRing: RingBuffer | null,
  queryHash: number,
  out: RenderSlot,
): NonNullable<RecallOpts['showRanked']> {
  return ({ ranked, pool, droppedByScope }, apiResult) => {
    // Sections are paid in print order, ahead of the memories and after the heading; one that does not fit is dropped whole.
    let left = budget - memoriesReserve(budget);
    const pays = (piece: string): boolean => {
      const tokens = estimateTokens(piece);
      if (tokens > left) return false;
      left -= tokens;
      return true;
    };
    const planPiece = planningSection(apiResult);
    const showPlan = planPiece !== '' && pays(planPiece);
    const tailRows = apiResult.results.filter((r) => r.isFreshTail || r.isSummary);
    const showTail = tailRows.length > 0 && pays(tailSection(tailRows));
    const continuityPiece = includeContinuity && apiResult.continuity ? `\n\n${formatContinuityBlock(apiResult.continuity)}` : '';
    const showContinuity = continuityPiece !== '' && pays(continuityPiece);

    // The hints and Cutoff block describe the list MCP shows, not the window band in apiResult.
    const render = (cut: SearchResult[]): RenderedRecall => {
      const list = dropHeldCopies(cut, (r) => r.entry); // after every cut, so a merged row cut here never hides its sources
      const anchoring = anchorRing ? detectAnchoring(snapshotRing(anchorRing), queryHash, list[0]?.entry.id ?? null) : null;
      const availability = biasHintEnabled('availability')
        ? detectAvailabilityBias({
            topK: list.map((r) => ({ id: r.entry.id, created: r.entry.created })),
            pool: pool.map((e) => ({ id: e.id, created: e.created })),
          })
        : null;
      const shownIds = new Set(list.map((r) => r.entry.id));
      const shownKeys = storedTextKeys(list.map((r) => r.entry));
      const tail = showTail
        ? dropHeldCopies(tailRows.filter((r) => !shownIds.has(r.id) && !shownKeys.has(duplicateKey(r.content))), (r) => r)
        : [];
      const s = buildSuppressionSummary({
        totalCandidates: pool.length + droppedByScope,
        droppedPreRank: droppedByScope + cut.length - list.length, // the bucket CLI and API recall put hidden copies in
        droppedByBudget: Math.max(0, pool.length - cut.length), // an upper bound: rows that never matched count too
        summarySubstitutionsAdded: tail.filter((r) => r.isSummary).length,
        freshTailAdded: tail.filter((r) => r.isFreshTail && !r.isSummary).length,
        suppressedByInterference: anchoring?.reason === 'memory_dominance' ? 1 : 0,
      });
      // Anchoring is the stronger pull, so it prints first; the Cutoff block sits above the list, where the agent reads it.
      let text = anchoring ? `## Anchoring hint\n${anchoring.summary}\n[anchored_on: ${anchoring.memoryId}]\n\n---\n\n` : '';
      if (availability) text += `## Availability bias\n${availability.summary}\n\n---\n\n`;
      if (showPlan) text += planPiece;
      const cutoffClauses: string[] = [];
      if (s.droppedByBudget > 0) cutoffClauses.push(`${s.droppedByBudget} dropped to fit limit`);
      if (s.droppedPreRank > 0) cutoffClauses.push(`${s.droppedPreRank} filtered pre-rank`);
      if (s.summarySubstitutionsAdded > 0) cutoffClauses.push(`${s.summarySubstitutionsAdded} summary substitutions added`);
      if (s.freshTailAdded > 0) cutoffClauses.push(`${s.freshTailAdded} fresh-tail added`);
      if (s.suppressedByInterference > 0) cutoffClauses.push(`${s.suppressedByInterference} suppressed by interference`);
      if (cutoffClauses.length > 0) {
        text += `## Cutoff\nShowing ${list.length} of ${s.totalCandidates} candidates; ${cutoffClauses.join('; ')}.\n\n---\n\n`;
      }
      // The window band's fresh-tail and summary rows follow the ranked list, or the MCP fields go unanswered.
      text += formatMemories(list) + tailSection(tail) + (showContinuity ? continuityPiece : '');
      return { anchoring, availability, text, list };
    };
    let results = fitBudget(ranked, Math.max(0, left), 1, memoryCost);
    let rendered = render(results);
    // The hints, Cutoff block and heading vary with the list, so the lowest-ranked entry goes until the whole response fits.
    while (results.length > 1 && estimateTokens(rendered.text) > budget) {
      results = results.slice(0, -1);
      rendered = render(results);
    }
    out.rendered = rendered;
    return rendered.list.map((r) => r.entry.id);
  };
}

export async function runRecallTool(call: ToolCall): Promise<string> {
  const { ctx, hippoRoot, config, tenantId, args } = call;
  // MCP keeps its own band size and search mode, so limit, mode and explain are checked but not passed on.
  const { opts: recallOpts } = parseRecallRequest(toolParams(args));
  const { query, includeContinuity, sessionId } = recallOpts;
  const budget = Number(args.budget) || config.defaultBudget;
  const apiCtx: ApiContext = {
    hippoRoot,
    tenantId,
    actor: mcpActor(ctx),
  };
  const anchorRing = sessionRing('mcp', tenantId, sessionId);
  const queryHash = hashQueryText(query);
  const out: RenderSlot = {};
  // RecallContractError throws reach the MCP caller raw, as mcp-recall-fresh-tail-policy.test.ts pins.
  await apiRetrieve(apiCtx, {
    ...recallOpts,
    limit: 50,
    mode: config.physics?.enabled !== false ? 'physics' : 'hybrid',
    // The hint is computed below over the list MCP shows; the window band's copy would emit its audit row twice.
    suppressAvailabilityHint: true,
    keepHeldCopies: true,
    showRanked: recallPresenter(budget, includeContinuity, anchorRing, queryHash, out),
  });
  if (!out.rendered) throw new Error('hippo_recall: api.retrieve returned without calling showRanked');
  lastRecalledIds.set(resolveClientKey(ctx), out.rendered.list.map((r) => r.entry.id));
  const { anchoring, availability, list } = out.rendered;
  const who = { hippoRoot, tenantId, actor: ctx?.actor ?? 'mcp' };
  recordShownRecall(who, { query, ring: anchorRing, topId: list[0]?.entry.id ?? null, anchoring, availability });
  return out.rendered.text;
}

export function runAssembleTool({ args, ctx, hippoRoot, tenantId }: ToolCall): string {
  const sessionId = String(args.session_id || '');
  if (!sessionId) return 'No session_id provided.';
  const budget = Number(args.budget);
  const freshTailCount = Number(args.fresh_tail_count);
  const summarizeOlder = args.summarize_older !== false;
  const apiCtx: ApiContext = {
    hippoRoot,
    tenantId,
    actor: mcpActor(ctx),
  };
  const explicitScope = isJsonString(args.scope) && args.scope.length > 0
    ? args.scope
    : undefined;
  const assembleExtra: AssembleExtraOpts = {};
  if (Number.isFinite(budget) && budget > 0) assembleExtra.budget = budget;
  if (Number.isFinite(freshTailCount) && freshTailCount >= 0) assembleExtra.freshTailCount = freshTailCount;
  if (explicitScope !== undefined) assembleExtra.scope = explicitScope;
  const r = apiAssemble(apiCtx, sessionId, {
    summarizeOlder,
    ...assembleExtra,
    cost: assembleCost(sessionId),
  });
  return assembleText(r);
}

export function runDrillTool({ args, ctx, hippoRoot, tenantId }: ToolCall): string {
  const summaryId = String(args.summary_id || '');
  if (!summaryId) return 'No summary_id provided.';
  const limit = Number(args.limit);
  const budget = Number(args.budget);
  // The inputSchema rejects a depth outside 1..10 before this runs, so no silent clamp hides the cap.
  const depth = args.depth === undefined ? undefined : Number(args.depth);
  const apiCtx: ApiContext = {
    hippoRoot,
    tenantId,
    actor: mcpActor(ctx),
  };
  const drillExtra: DrillDownExtraOpts = {};
  if (Number.isFinite(limit) && limit > 0) drillExtra.limit = limit;
  if (Number.isFinite(budget) && budget > 0) drillExtra.budget = budget;
  if (depth !== undefined) drillExtra.depth = depth;
  const r = apiDrillDown(apiCtx, summaryId, { ...drillExtra, cost: drillCost });
  if ('failure' in r) {
    // Only not_drillable is caller-actionable. not_found merges cross-tenant, scope-blocked and
    // missing, because telling scope_blocked apart would leak private-row existence.
    if (r.failure === 'not_drillable') {
      return `Id ${summaryId} is a leaf row, not a level-2+ summary; nothing to drill into.`;
    }
    return `No drillable summary at id=${summaryId}.`;
  }
  return drillText(r);
}

export async function runContextTool({ args, ctx, hippoRoot, config, tenantId }: ToolCall): Promise<string> {
  const { budget: budgetArg, scope: exactScope } = parseContextRequest(toolParams(args));
  const budget = budgetArg ?? config.defaultContextBudget;
  if (budget === 0) return '';
  if (budget < memoriesReserve(budget)) return ''; // not even the heading fits, so nothing prints, as at budget 0
  // The served store names the project (an HTTP daemon runs from anywhere); the global root names none, so stdio falls back to its launch cwd.
  const storeProject = resolveProjectIdentity(path.dirname(path.resolve(hippoRoot)));
  const result = await apiGetContext(
    { hippoRoot, tenantId, actor: mcpActor(ctx) },
    {
      q: autoDetectContext(),
      budget,
      exactScope,
      currentProject: storeProject.name !== '' ? storeProject : resolveProjectIdentity(process.cwd()),
      cost: contextCost,
    },
  );
  lastRecalledIds.set(resolveClientKey(ctx), result.entries.map((r) => r.entry.id));
  return (result.activeSnapshot ? snapshotPiece(result.activeSnapshot) : '')
    + (result.sessionHandoff ? handoffPiece(result.sessionHandoff) : '')
    + (result.recentEvents ? trailPiece(result.recentEvents) : '')
    + formatMemories(result.entries);
}
