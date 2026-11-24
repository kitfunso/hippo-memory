import * as path from 'node:path';
import {
  drillDown as apiDrillDown,
  assemble as apiAssemble,
  contextGet as apiGetContext,
} from '../../api/index.js';
import { autoDetectContext } from '../../api/context/context-auto.js';
import { sharedStoreOf } from '../../api/types.js';
import { type ProjectIdentity } from '../../base/scope/project-identity.js';
import type { Machine } from '../../base/util/agent-homes.js';
import {
  assembleCost,
  assembleText,
  drillCost,
  drillText,
} from '../../api/context/context-render.js';
import { mcpApiContext, ownsServerCwd, type GroupToolCall, type ToolCall } from './protocol.js';
import { toolRecallText } from './tool-recall.js';
import {
  formatMemories,
  memoriesReserve,
  snapshotPiece,
  handoffPiece,
  trailPiece,
  contextCostAt,
} from './tool-text.js';
import { MAX_ID_LEN } from '../../base/util/limits.js';
import { boolArg, numberArg, stringArg } from './tool-args.js';
import { parseContextRequest, parseRecallRequest, toolParams } from '../../api/recall/request.js';

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
  const { opts } = parseRecallRequest(toolParams(args));
  return toolRecallText(mcpApiContext(ctx), {
    opts,
    budget: numberArg(args, 'budget') || undefined,
    project: ctx.project,
  });
}

export async function runAssembleTool({
  args,
  ctx,
  api,
}: GroupToolCall<'dagReads'>): Promise<string> {
  const sessionId = stringArg(args, 'session_id', MAX_ID_LEN);
  if (!sessionId) return 'No session_id provided.';
  const budget = numberArg(args, 'budget');
  const freshTailCount = numberArg(args, 'fresh_tail_count');
  const summarizeOlder = boolArg(args, 'summarize_older', true);
  const explicitScope = stringArg(args, 'scope', MAX_ID_LEN) || undefined;
  const assembleExtra: AssembleExtraOptions = {};
  if (budget !== undefined && budget > 0) assembleExtra.budget = budget;
  if (freshTailCount !== undefined && freshTailCount >= 0) {
    assembleExtra.freshTailCount = freshTailCount;
  }
  if (explicitScope !== undefined) assembleExtra.scope = explicitScope;
  const r = await apiAssemble(api, sessionId, {
    summarizeOlder,
    project: ctx?.project,
    ...assembleExtra,
    cost: assembleCost(sessionId),
  });
  return assembleText(r);
}

export async function runDrillTool({ args, ctx, api }: GroupToolCall<'dagReads'>): Promise<string> {
  const summaryId = stringArg(args, 'summary_id', MAX_ID_LEN);
  if (!summaryId) return 'No summary_id provided.';
  const limit = numberArg(args, 'limit');
  const budget = numberArg(args, 'budget');
  const depth = numberArg(args, 'depth');
  const drillExtra: DrillDownExtraOptions = {};
  if (limit !== undefined && limit > 0) drillExtra.limit = limit;
  if (budget !== undefined && budget > 0) drillExtra.budget = budget;
  if (depth !== undefined) drillExtra.depth = depth;
  const opts = { ...drillExtra, project: ctx?.project, cost: drillCost };
  const r = await apiDrillDown(api, summaryId, opts);
  if ('failure' in r) {
    if (r.failure === 'not_drillable') {
      return `Id ${summaryId} is a leaf row, not a level-2+ summary; nothing to drill into.`;
    }
    return `No drillable summary at id=${summaryId}.`;
  }
  return drillText(r);
}

function localProject(
  hippoRoot: string,
  ownsCwd: boolean,
  { projectIdentity, cwd }: Pick<Machine, 'projectIdentity' | 'cwd'>,
): ProjectIdentity {
  const storeProject = projectIdentity(path.dirname(path.resolve(hippoRoot)));
  return storeProject.name !== '' || !ownsCwd || cwd === undefined
    ? storeProject
    : projectIdentity(cwd);
}

export async function runContextTool({ args, ctx, hippoRoot, config }: ToolCall): Promise<string> {
  if (sharedStoreOf(ctx) && ctx.project === undefined) {
    return 'hippo_context needs a project on a shared store; use hippo_recall';
  }
  const { budget: budgetArg, scope: exactScope } = parseContextRequest(toolParams(args));
  const budget = budgetArg ?? config.defaultContextBudget;
  if (budget === 0) return '';
  if (budget < memoriesReserve(budget)) return '';
  const ownsCwd = ownsServerCwd(ctx);
  const now = ctx.infra.clock();
  const result = await apiGetContext(mcpApiContext(ctx), {
    q: ctx?.project || !ownsCwd ? undefined : autoDetectContext(ctx.infra.machine.git),
    budget,
    exactScope,
    currentProject: ctx?.project ?? localProject(hippoRoot, ownsCwd, ctx.infra.machine),
    cost: contextCostAt(now),
  });
  return (
    (result.activeSnapshot ? snapshotPiece(result.activeSnapshot) : '') +
    (result.sessionHandoff ? handoffPiece(result.sessionHandoff) : '') +
    (result.recentEvents ? trailPiece(result.recentEvents) : '') +
    formatMemories(result.entries, now)
  );
}
