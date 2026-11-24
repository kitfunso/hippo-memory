import { assembleCost, contextCost, drillCost } from '../../../api/context/context-render.js';
import {
  assemble,
  type AssembleOptions,
  drillDown,
  type DrillDownOptions,
  contextGet,
  contextProjectFor,
  recordTokens,
  retrieve,
} from '../../../api/index.js';
import { RECALL_RECORDING } from '../../../api/recall/finish.js';
import {
  continuityJson,
  sessionEventJson,
  snapshotJson,
} from '../../../api/continuity/continuity-json.js';
import {
  httpParams,
  optionalFlagParam,
  parseContextRequest,
  parseRecallRequest,
} from '../../../api/recall/request.js';
import { HttpError } from '../../../base/errors/http-errors.js';
import { sendJson } from '../../http/http-util.js';
import type { AuthedRouteRequest, GroupRequest, RouteParams } from '../types.js';
import { MAX_LIST_LIMIT } from '../../../base/util/limits.js';
import {
  parseIntParam,
  parseLimitParam,
  parseNumberParam,
  validateIdSegment,
} from '../validation.js';

export async function handleRecallMemories({ res, ctx, query }: AuthedRouteRequest): Promise<void> {
  const { opts: recallOpts, limit, mode, explain } = parseRecallRequest(httpParams(query));
  const result = await retrieve(ctx, {
    ...recallOpts,
    window: { ...recallOpts.window, limit },
    mode,
    trace: { explain, recordAs: RECALL_RECORDING.http },
  });

  sendJson(
    res,
    200,
    result.continuity ? { ...result, continuity: continuityJson(result.continuity) } : result,
  );
  return;
}

export async function handleAssembleSession(
  { res, ctx, query }: GroupRequest<'dagReads'>,
  { id }: RouteParams,
): Promise<void> {
  validateIdSegment(id, 'session id');
  const budget = parseNumberParam(query.get('budget'), 'budget');
  const freshTailCount = parseNumberParam(query.get('freshTail'), 'freshTail', true);
  const summarizeOlder = optionalFlagParam(httpParams(query), 'summarizeOlder');
  const scopeQ = query.get('scope');
  const scope = scopeQ !== null && scopeQ.length > 0 ? scopeQ : undefined;
  const assembleExtra: Pick<
    AssembleOptions,
    'budget' | 'freshTailCount' | 'summarizeOlder' | 'scope'
  > = {};
  if (budget !== undefined) assembleExtra.budget = budget;
  if (freshTailCount !== undefined) assembleExtra.freshTailCount = freshTailCount;
  if (summarizeOlder !== undefined) assembleExtra.summarizeOlder = summarizeOlder;
  if (scope !== undefined) assembleExtra.scope = scope;
  const result = await assemble(ctx, id, { ...assembleExtra, cost: assembleCost(id) });
  await recordTokens(ctx, 'http_assemble', {
    items: result.items.length,
    tokens: result.tokens,
    sessionId: id,
  });
  sendJson(res, 200, result);
  return;
}

export async function handleDrillRecall(
  { res, ctx, query }: GroupRequest<'dagReads'>,
  { id }: RouteParams,
): Promise<void> {
  validateIdSegment(id, 'summary id');
  const limitRaw = query.get('limit');
  const limit = parseNumberParam(limitRaw, 'limit');
  if (limit !== undefined && limit > MAX_LIST_LIMIT) parseLimitParam(limitRaw);
  const budget = parseNumberParam(query.get('budget'), 'budget');
  const depth = parseIntParam(query.get('depth'), 'depth', 1, 10);
  const drillExtra: Pick<DrillDownOptions, 'limit' | 'budget' | 'depth'> = {};
  if (limit !== undefined) drillExtra.limit = limit;
  if (budget !== undefined) drillExtra.budget = budget;
  if (depth !== undefined) drillExtra.depth = depth;
  const result = await drillDown(ctx, id, { ...drillExtra, cost: drillCost });
  if ('failure' in result) {
    if (result.failure === 'not_drillable') {
      throw new HttpError(422, 'Id is a leaf row, not a level-2+ summary; nothing to drill into');
    }
    throw new HttpError(404, 'No drillable summary at this id');
  }
  sendJson(res, 200, result);
  return;
}

export async function handleGetContext({
  res,
  ctx,
  query,
  opts,
}: AuthedRouteRequest): Promise<void> {
  const parsed = parseContextRequest(httpParams(query));
  const result = await contextGet(ctx, {
    ...parsed,
    currentProject: contextProjectFor(ctx, {
      storeDir: opts.hippoRoot,
      project: query.get('project'),
      aliases: query.getAll('alias'),
    }),
    cost: contextCost('markdown', 'observe', ctx.infra.clock()),
  });
  await recordTokens(ctx, 'http_context', { items: result.entries.length, tokens: result.tokens });
  sendJson(res, 200, {
    ...result,
    activeSnapshot: result.activeSnapshot && snapshotJson(result.activeSnapshot),
    recentEvents: result.recentEvents?.map(sessionEventJson),
  });
  return;
}
