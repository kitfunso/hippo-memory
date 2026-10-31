// Read-side tool handlers: hippo_recall, hippo_assemble, hippo_drill and hippo_context.

import * as path from 'path';
import { fitBudget } from '../search/finalize.js';
import type { SearchResult } from '../core/search-types.js';
import { dropHeldCopies, duplicateKey, storedTextKeys } from '../util/same-text.js';
import {
  retrieve as apiRetrieve,
  drillDown as apiDrillDown,
  assemble as apiAssemble,
  getContext as apiGetContext,
  type ContextWith,
  type StoreContext,
  type RecallOpts,
  type RecallSuppressionSummary,
} from '../api/index.js';
import { autoDetectContext } from '../api/context-auto.js';
import { resolveProjectIdentity, type ProjectIdentity } from '../core/project-identity.js';
import { isSharedStore } from '../core/config.js';
import type { AppendAuditOpts } from '../store/audit.js';
import { hashQueryText, type RingBuffer } from '../api/recall/finish.js';
import {
  availabilityPool,
  cutoffClauses,
  detectRecallHints,
  shrinkToFit,
  suppressionSummary,
  tokenPurse,
  type SuppressionCounts,
} from '../api/recall/render.js';
import { estimateTokens } from '../util/token-text.js';
import { assembleCost, assembleText, drillCost, drillText } from '../api/context-render.js';
import { mcpActor, ownsServerCwd, type ToolCall } from './protocol.js';
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
import { isJsonString } from '../util/json.js';
import { parseContextRequest, parseRecallRequest, toolParams } from '../api/recall/request.js';
import { noteRecall, sessionRing, shownRecallRows } from '../api/recall/finish.js';

// Named shapes for optional fields each api.* call only wants when the caller supplied them: build `extra`, then spread
// once, which keeps per-field omission without the `...(cond ? { field } : {})` pattern.
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

/** Builds the showRanked callback that renders the list MCP
 * shows, parks the render in `out` and hands back its hint rows. */
interface RecallPresenterOptions {
  readonly includeContinuity: boolean;
  readonly anchorRing: RingBuffer | null;
  readonly queryHash: number;
  readonly out: RenderSlot;
  readonly hintRows: (rendered: RenderedRecall) => AppendAuditOpts[];
}

// Candidate pool the MCP recall ranks before the token budget trims what is shown.
const MCP_RECALL_LIMIT = 50;

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

function fitMcpRecall(
  ranked: SearchResult[],
  limits: { room: number; budget: number },
  render: (cut: SearchResult[]) => RenderedRecall,
): RenderedRecall {
  const fitted = fitBudget(ranked, Math.max(0, limits.room), 1, memoryCost);
  return shrinkToFit(fitted.length, 1, limits.budget, (n) => render(fitted.slice(0, n)), (r) => r.text);
}

function recallPresenter(budget: number, options: RecallPresenterOptions): NonNullable<RecallOpts['showRanked']> {
  const { includeContinuity, anchorRing, queryHash, out, hintRows } = options;
  return ({ ranked, pool, droppedByScope }, apiResult) => {
    // Sections are paid in print order, ahead of the memories and
    // after the heading; one that does not fit is dropped whole.
    const purse = tokenPurse(budget - memoriesReserve(budget));
    const pays = (piece: string): boolean => purse.pays(estimateTokens(piece));
    const hintPool = availabilityPool(() => pool);
    const planPiece = planningSection(apiResult);
    const showPlan = planPiece !== '' && pays(planPiece);
    const tailRows = apiResult.results.filter((r) => r.isFreshTail || r.isSummary);
    const showTail = tailRows.length > 0 && pays(tailSection(tailRows));
    const continuityPiece =
      includeContinuity && apiResult.continuity ? `\n\n${formatContinuityBlock(apiResult.continuity)}` : '';
    const showContinuity = continuityPiece !== '' && pays(continuityPiece);

    // The hints and Cutoff block describe the list MCP shows, not the window band in apiResult.
    const render = (cut: SearchResult[]): RenderedRecall => {
      // After every cut, so a merged row cut here never hides its sources.
      const list = dropHeldCopies(cut, (r) => r.entry);
      const { anchoring, availability } = detectRecallHints({ list, pool: hintPool, anchorRing, queryHash });
      const shownIds = new Set(list.map((r) => r.entry.id));
      const shownKeys = storedTextKeys(list.map((r) => r.entry));
      const tail = showTail
        ? dropHeldCopies(
            tailRows.filter((r) => !shownIds.has(r.id) && !shownKeys.has(duplicateKey(r.content))),
            (r) => r,
          )
        : [];
      const counts = suppressionCounts({ poolSize: pool.length, droppedByScope, cut, list, tail });
      const s = suppressionSummary(counts, anchoring);
      // Anchoring is the stronger pull, so it prints first; the
      // Cutoff block sits above the list, where the agent reads it.
      let text = biasHintSections(anchoring, availability);
      if (showPlan) text += planPiece;
      text += cutoffSection(s, list.length);
      // The window band's fresh-tail and summary rows follow the ranked list, or the MCP fields go unanswered.
      text += formatMemories(list) + tailSection(tail) + (showContinuity ? continuityPiece : '');
      return { anchoring, availability, text, list };
    };
    const rendered = fitMcpRecall(ranked, { room: purse.left(), budget }, render);
    out.rendered = rendered;
    return { ids: rendered.list.map((r) => r.entry.id), audit: hintRows(rendered) };
  };
}

export async function runRecallTool(call: ToolCall): Promise<string> {
  const { ctx, hippoRoot, config, tenantId, args, store } = call;
  // MCP keeps its own band size and search mode, so limit, mode and explain are checked but not passed on.
  const { opts: recallOpts } = parseRecallRequest(toolParams(args));
  const { query, includeContinuity, sessionId } = recallOpts;
  const budget = Number(args.budget) || config.defaultBudget;
  const apiCtx: StoreContext = {
    hippoRoot,
    tenantId,
    actor: mcpActor(ctx),
    store,
    reach: ctx?.reach,
  };
  const anchorRing = sessionRing('mcp', tenantId, sessionId);
  const who = { tenantId, actor: ctx?.actor ?? 'mcp' };
  const queryHash = hashQueryText(query);
  const out: RenderSlot = {};
  // RecallContractError throws reach the MCP caller raw, as mcp-recall-fresh-tail-policy.test.ts pins.
  await apiRetrieve(apiCtx, {
    ...recallOpts,
    limit: MCP_RECALL_LIMIT,
    mode: config.physics?.enabled !== false ? 'physics' : 'hybrid',
    // The hint is computed below over the list MCP shows; the window band's copy would emit its audit row twice.
    suppressAvailabilityHint: true,
    keepHeldCopies: true,
    project: ctx?.project,
    showRanked: recallPresenter(budget, {
      includeContinuity,
      anchorRing,
      queryHash,
      out,
      hintRows: ({ list, anchoring, availability }) =>
        shownRecallRows(who, { query, ring: anchorRing, topId: list[0]?.entry.id ?? null, anchoring, availability }),
    }),
  });
  const { rendered } = out;
  if (!rendered) throw new Error('hippo_recall: api.retrieve returned without calling showRanked');
  lastRecalledIds.set(
    resolveClientKey(ctx),
    rendered.list.map((r) => r.entry.id),
  );
  // Fed once the recall's rows are written, after the final detect: anchoredOn feeds the cooldown for the next recall
  // on this session.
  if (anchorRing) noteRecall(anchorRing, query, rendered.list[0]?.entry.id ?? null, rendered.anchoring?.memoryId);
  return rendered.text;
}

export async function runAssembleTool(
  { args, ctx, hippoRoot, tenantId, store }: ToolCall<'dagReads'>
): Promise<string> {
  const sessionId = String(args.session_id || '');
  if (!sessionId) return 'No session_id provided.';
  const budget = Number(args.budget);
  const freshTailCount = Number(args.fresh_tail_count);
  const summarizeOlder = args.summarize_older !== false;
  const apiCtx: ContextWith<'dagReads'> = {
    hippoRoot,
    tenantId,
    actor: mcpActor(ctx),
    store,
  };
  const explicitScope = isJsonString(args.scope) && args.scope.length > 0
    ? args.scope
    : undefined;
  const assembleExtra: AssembleExtraOpts = {};
  if (Number.isFinite(budget) && budget > 0) assembleExtra.budget = budget;
  if (Number.isFinite(freshTailCount) && freshTailCount >= 0) assembleExtra.freshTailCount = freshTailCount;
  if (explicitScope !== undefined) assembleExtra.scope = explicitScope;
  const r = await apiAssemble(apiCtx, sessionId, {
    summarizeOlder,
    project: ctx?.project,
    ...assembleExtra,
    cost: assembleCost(sessionId),
  });
  return assembleText(r);
}

export async function runDrillTool({ args, ctx, hippoRoot, tenantId, store }: ToolCall<'dagReads'>): Promise<string> {
  const summaryId = String(args.summary_id || '');
  if (!summaryId) return 'No summary_id provided.';
  const limit = Number(args.limit);
  const budget = Number(args.budget);
  // The inputSchema rejects a depth outside 1..10 before this runs, so no silent clamp hides the cap.
  const depth = args.depth === undefined ? undefined : Number(args.depth);
  const apiCtx: ContextWith<'dagReads'> = {
    hippoRoot,
    tenantId,
    actor: mcpActor(ctx),
    store,
  };
  const drillExtra: DrillDownExtraOpts = {};
  if (Number.isFinite(limit) && limit > 0) drillExtra.limit = limit;
  if (Number.isFinite(budget) && budget > 0) drillExtra.budget = budget;
  if (depth !== undefined) drillExtra.depth = depth;
  const r = await apiDrillDown(apiCtx, summaryId, { ...drillExtra, project: ctx?.project, cost: drillCost });
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

// The served store names the project (an HTTP daemon runs from anywhere); the global root names none, so only an owner
// of the server cwd falls back to it.
function localProject(hippoRoot: string, ownsCwd: boolean): ProjectIdentity {
  const storeProject = resolveProjectIdentity(path.dirname(path.resolve(hippoRoot)));
  return storeProject.name !== '' || !ownsCwd ? storeProject : resolveProjectIdentity(process.cwd());
}

export async function runContextTool(
  { args, ctx, hippoRoot, config, tenantId, store }: ToolCall<'contextReads'>
): Promise<string> {
  // Stdio names no project, and the store's folder or the launch cwd is no caller's; HTTP sends X-Hippo-Project.
  if ((ctx?.reach ? ctx.reach.shared : isSharedStore(hippoRoot)) && ctx?.project === undefined) {
    return 'hippo_context needs a project on a shared store; use hippo_recall';
  }
  const { budget: budgetArg, scope: exactScope } = parseContextRequest(toolParams(args));
  const budget = budgetArg ?? config.defaultContextBudget;
  if (budget === 0) return '';
  if (budget < memoriesReserve(budget)) return ''; // not even the heading fits, so nothing prints, as at budget 0
  const ownsCwd = ownsServerCwd(ctx);
  const result = await apiGetContext(
    { hippoRoot, tenantId, actor: mcpActor(ctx), store, reach: ctx?.reach },
    {
      // The server's git state is no remote caller's, so a project
      // or remote caller gets rows by strength without a query.
      q: ctx?.project || !ownsCwd ? undefined : autoDetectContext(),
      budget,
      exactScope,
      currentProject: ctx?.project ?? localProject(hippoRoot, ownsCwd),
      cost: contextCost,
    },
  );
  lastRecalledIds.set(resolveClientKey(ctx), result.entries.map((r) => r.entry.id));
  return (result.activeSnapshot ? snapshotPiece(result.activeSnapshot) : '')
    + (result.sessionHandoff ? handoffPiece(result.sessionHandoff) : '')
    + (result.recentEvents ? trailPiece(result.recentEvents) : '')
    + formatMemories(result.entries);
}
