// Read-side tool handlers: hippo_recall, hippo_assemble, hippo_drill and hippo_context.

import * as path from 'path';
import { drillDown as apiDrillDown, assemble as apiAssemble, contextGet as apiGetContext } from '../api/index.js';
import { autoDetectContext } from '../api/context-auto.js';
import { sharedStoreOf } from '../api/types.js';
import { resolveProjectIdentity, type ProjectIdentity } from '../core/project-identity.js';
import { assembleCost, assembleText, drillCost, drillText } from '../api/context-render.js';
import { mcpApiContext, ownsServerCwd, type ToolCall } from './protocol.js';
import { resolveClientKey } from '../api/recall/last-recalled.js';
import { toolRecallText } from '../api/recall/tool-recall.js';
import {
  formatMemories,
  memoriesReserve,
  snapshotPiece,
  handoffPiece,
  trailPiece,
  contextCost,
} from '../api/recall/tool-text.js';
import { isJsonString } from '../util/json.js';
import { parseContextRequest, parseRecallRequest, toolParams } from '../api/recall/request.js';

// Named shapes for optional fields each api.* call only wants when the caller supplied them: build `extra`, then spread
// once, which keeps per-field omission without the `...(cond ? { field } : {})` pattern.
interface AssembleExtraOptions {
  budget?: number;
  freshTailCount?: number;
  scope?: string;
}

interface DrillDownExtraOptions {
  limit?: number;
  budget?: number;
  depth?: number;
}

export async function runRecallTool({ ctx, args }: ToolCall): Promise<string> {
  // MCP keeps its own band size and search mode, so limit, mode and explain are checked but not passed on.
  const { opts } = parseRecallRequest(toolParams(args));
  return toolRecallText(mcpApiContext(ctx), {
    opts,
    budget: Number(args.budget) || undefined,
    project: ctx.project,
    clientKey: resolveClientKey(ctx),
  });
}

export async function runAssembleTool({ args, ctx }: ToolCall): Promise<string> {
  const sessionId = String(args.session_id || '');
  if (!sessionId) return 'No session_id provided.';
  const budget = Number(args.budget);
  const freshTailCount = Number(args.fresh_tail_count);
  const summarizeOlder = args.summarize_older !== false;
  const explicitScope = isJsonString(args.scope) && args.scope.length > 0 ? args.scope : undefined;
  const assembleExtra: AssembleExtraOptions = {};
  if (Number.isFinite(budget) && budget > 0) assembleExtra.budget = budget;
  if (Number.isFinite(freshTailCount) && freshTailCount >= 0) assembleExtra.freshTailCount = freshTailCount;
  if (explicitScope !== undefined) assembleExtra.scope = explicitScope;
  const r = await apiAssemble(mcpApiContext(ctx), sessionId, {
    summarizeOlder,
    project: ctx?.project,
    ...assembleExtra,
    cost: assembleCost(sessionId),
  });
  return assembleText(r);
}

export async function runDrillTool({ args, ctx }: ToolCall): Promise<string> {
  const summaryId = String(args.summary_id || '');
  if (!summaryId) return 'No summary_id provided.';
  const limit = Number(args.limit);
  const budget = Number(args.budget);
  // The inputSchema rejects a depth outside 1..10 before this runs, so no silent clamp hides the cap.
  const depth = args.depth === undefined ? undefined : Number(args.depth);
  const drillExtra: DrillDownExtraOptions = {};
  if (Number.isFinite(limit) && limit > 0) drillExtra.limit = limit;
  if (Number.isFinite(budget) && budget > 0) drillExtra.budget = budget;
  if (depth !== undefined) drillExtra.depth = depth;
  const opts = { ...drillExtra, project: ctx?.project, cost: drillCost };
  const r = await apiDrillDown(mcpApiContext(ctx), summaryId, opts);
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

export async function runContextTool({ args, ctx, hippoRoot, config }: ToolCall): Promise<string> {
  // Stdio names no project, and the store's folder or the launch cwd is no caller's; HTTP sends X-Hippo-Project.
  if (sharedStoreOf(ctx) && ctx.project === undefined) {
    return 'hippo_context needs a project on a shared store; use hippo_recall';
  }
  const { budget: budgetArg, scope: exactScope } = parseContextRequest(toolParams(args));
  const budget = budgetArg ?? config.defaultContextBudget;
  if (budget === 0) return '';
  if (budget < memoriesReserve(budget)) return ''; // not even the heading fits, so nothing prints, as at budget 0
  const ownsCwd = ownsServerCwd(ctx);
  const result = await apiGetContext(mcpApiContext(ctx), {
    // The server's git state is no remote caller's, so a project
    // or remote caller gets rows by strength without a query.
    q: ctx?.project || !ownsCwd ? undefined : autoDetectContext(),
    budget,
    exactScope,
    currentProject: ctx?.project ?? localProject(hippoRoot, ownsCwd),
    cost: contextCost,
  });
  ctx.callers?.lastShown.set(
    resolveClientKey(ctx),
    result.entries.map((r) => r.entry.id),
  );
  return (
    (result.activeSnapshot ? snapshotPiece(result.activeSnapshot) : '') +
    (result.sessionHandoff ? handoffPiece(result.sessionHandoff) : '') +
    (result.recentEvents ? trailPiece(result.recentEvents) : '') +
    formatMemories(result.entries)
  );
}
