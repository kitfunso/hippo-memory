import type { Context } from '../api/index.js';
import { handleGitHubEventsWebhook } from '../connectors/github/webhook.js';
import { handleSlackEventsWebhook } from '../connectors/slack/webhook.js';
import { hasGroup, type StoreGroup, type HippoStore } from '../store/index.js';
import { HttpError, JSON_HEADERS, sendJson, STORE_NOT_PORTED_MESSAGE, type WebhookRequest } from '../util/http-util.js';
import { assertCrossTenantAdmin, buildContextWithAuth, isLocalCaller } from './auth.js';
import { matchPath, noteAccess } from './request.js';
import { routeLookup } from './route-lookup.js';
import {
  handleApproveQuarantine,
  handleCreateAuthKey,
  handleListAudit,
  handleListAuthKeys,
  handleListQuarantine,
  handleRejectQuarantine,
  handleRevokeAuthKey
} from './routes/admin.js';
import {
  handleCloseCustomerNote,
  handleCreateCustomerNote,
  handleGetCustomerNote,
  handleListCustomerNotes,
  handleSupersedeCustomerNote
} from './routes/customer-notes.js';
import {
  handleCloseDecision,
  handleCreateDecision,
  handleGetDecision,
  handleListDecisions,
  handleSupersedeDecision,
} from './routes/decisions.js';
import {
  handleCloseIncident,
  handleCreateIncident,
  handleGetIncident,
  handleListIncidents,
  handleResolveIncident,
} from './routes/incidents.js';
import {
  handleApplyOutcome,
  handleArchiveMemory,
  handleCreateMemory,
  handleForgetMemory,
  handleGetGraph,
  handlePromoteMemory,
  handleSleep,
  handleSupersedeMemory
} from './routes/memories.js';
import {
  handleClosePolicy,
  handleCreatePolicy,
  handleGetPolicy,
  handleListPolicies,
  handlePoliciesAsOf,
  handleSupersedePolicy,
} from './routes/policies.js';
import {
  handleClosePrediction,
  handleCreatePrediction,
  handleGetPrediction,
  handleListPredictions,
  handlePredictionStats,
} from './routes/predictions.js';
import {
  handleCloseProcess,
  handleCreateProcess,
  handleGetProcess,
  handleListProcesses,
  handleSupersedeProcess,
} from './routes/processes.js';
import {
  handleCloseProjectBrief,
  handleCreateProjectBrief,
  handleGetProjectBrief,
  handleListProjectBriefs,
  handleRefreshProjectBrief,
  handleSupersedeProjectBrief
} from './routes/project-briefs.js';
import { handleAssembleSession, handleDrillRecall, handleGetContext, handleRecallMemories } from './routes/recall.js';
import {
  handleCloseSkill,
  handleCreateSkill,
  handleExportSkills,
  handleGetSkill,
  handleListSkills,
  handleSupersedeSkill,
} from './routes/skills.js';
import { parseJsonBody } from './validation.js';
import type { AuthedRouteRequest, ResolvedServeOptions, Route, RouteRequest, RouteEndpoint } from './types.js';

function webhook(
  handle: (r: WebhookRequest, store: HippoStore) => Promise<void>,
): (r: RouteRequest) => Promise<void> {
  return async ({ req, res, opts }) => {
    await handle({ req, res, opts }, opts.store);
  };
}

/** The /v1 routes in dispatch order; the first entry whose method and path match handles the request. Each row's `auth`
 * is what the dispatch gate proves before its handler runs, so a handler never checks the caller itself. */
export const V1_ROUTES: readonly Route[] = [
  {
    method: 'POST',
    path: '/v1/memories',
    auth: 'caller',
    loop: 'off',
    handler: handleCreateMemory,
  },
  {
    method: 'GET',
    path: '/v1/graph',
    auth: 'caller',
    loop: 'off',
    handler: handleGetGraph,
  },
  {
    method: 'GET',
    path: '/v1/memories',
    auth: 'caller',
    loop: 'off',
    handler: handleRecallMemories,
  },
  {
    method: 'GET',
    pattern: '/v1/sessions/:id/assemble',
    auth: 'caller',
    loop: 'off',
    handler: handleAssembleSession,
  },
  {
    method: 'GET',
    pattern: '/v1/recall/drill/:id',
    auth: 'caller',
    loop: 'off',
    handler: handleDrillRecall,
  },
  {
    method: 'POST',
    pattern: '/v1/memories/:id/archive',
    auth: 'caller',
    loop: 'off',
    handler: handleArchiveMemory,
  },
  {
    method: 'POST',
    pattern: '/v1/memories/:id/supersede',
    auth: 'caller',
    loop: 'off',
    handler: handleSupersedeMemory,
  },
  {
    method: 'POST',
    pattern: '/v1/memories/:id/promote',
    auth: 'caller',
    storeReady: 'localFiles',
    handler: handlePromoteMemory,
  },
  {
    method: 'DELETE',
    pattern: '/v1/memories/:id',
    auth: 'caller',
    loop: 'off',
    handler: handleForgetMemory,
  },
  {
    method: 'POST',
    path: '/v1/outcome',
    auth: 'caller',
    loop: 'off',
    handler: handleApplyOutcome,
  },
  {
    method: 'GET',
    path: '/v1/context',
    auth: 'caller',
    loop: 'off',
    handler: handleGetContext,
  },
  {
    method: 'POST',
    path: '/v1/sleep',
    auth: 'host-admin-local',
    storeReady: 'localFiles',
    loop: 'off',
    handler: handleSleep,
  },
  {
    method: 'POST',
    path: '/v1/auth/keys',
    auth: 'admin',
    loop: 'off',
    handler: handleCreateAuthKey,
  },
  {
    method: 'GET',
    path: '/v1/auth/keys',
    auth: 'caller',
    loop: 'off',
    handler: handleListAuthKeys,
  },
  {
    method: 'DELETE',
    pattern: '/v1/auth/keys/:keyId',
    auth: 'caller',
    loop: 'off',
    handler: handleRevokeAuthKey,
  },
  {
    method: 'GET',
    path: '/v1/quarantine',
    auth: 'admin',
    loop: 'off',
    handler: handleListQuarantine,
  },
  {
    method: 'POST',
    pattern: '/v1/quarantine/:id/approve',
    auth: 'admin',
    loop: 'off',
    handler: handleApproveQuarantine,
  },
  {
    method: 'POST',
    pattern: '/v1/quarantine/:id/reject',
    auth: 'admin',
    loop: 'off',
    handler: handleRejectQuarantine,
  },
  {
    method: 'GET',
    path: '/v1/audit',
    auth: 'admin',
    loop: 'off',
    handler: handleListAudit,
  },
  {
    method: 'POST',
    path: '/v1/predictions',
    auth: 'caller',
    loop: 'off',
    handler: handleCreatePrediction,
  },
  {
    method: 'GET',
    path: '/v1/predictions',
    auth: 'caller',
    loop: 'off',
    handler: handleListPredictions,
  },
  {
    method: 'GET',
    path: '/v1/predictions/stats',
    auth: 'caller',
    loop: 'off',
    handler: handlePredictionStats,
  },
  {
    method: 'GET',
    regex: /^\/v1\/predictions\/(\d+)$/,
    auth: 'caller',
    loop: 'off',
    handler: handleGetPrediction,
  },
  {
    method: 'POST',
    regex: /^\/v1\/predictions\/(\d+)\/close$/,
    auth: 'caller',
    loop: 'off',
    handler: handleClosePrediction,
  },
  {
    method: 'POST',
    path: '/v1/decisions',
    auth: 'caller',
    loop: 'off',
    handler: handleCreateDecision,
  },
  {
    method: 'GET',
    path: '/v1/decisions',
    auth: 'caller',
    loop: 'off',
    handler: handleListDecisions,
  },
  {
    method: 'POST',
    regex: /^\/v1\/decisions\/(\d+)\/supersede$/,
    auth: 'caller',
    loop: 'off',
    handler: handleSupersedeDecision,
  },
  {
    method: 'POST',
    regex: /^\/v1\/decisions\/(\d+)\/close$/,
    auth: 'caller',
    loop: 'off',
    handler: handleCloseDecision,
  },
  {
    method: 'GET',
    regex: /^\/v1\/decisions\/(\d+)$/,
    auth: 'caller',
    loop: 'off',
    handler: handleGetDecision,
  },
  {
    method: 'POST',
    path: '/v1/incidents',
    auth: 'caller',
    loop: 'off',
    handler: handleCreateIncident,
  },
  {
    method: 'GET',
    path: '/v1/incidents',
    auth: 'caller',
    loop: 'off',
    handler: handleListIncidents,
  },
  {
    method: 'POST',
    regex: /^\/v1\/incidents\/(\d+)\/resolve$/,
    auth: 'caller',
    loop: 'off',
    handler: handleResolveIncident,
  },
  {
    method: 'POST',
    regex: /^\/v1\/incidents\/(\d+)\/close$/,
    auth: 'caller',
    loop: 'off',
    handler: handleCloseIncident,
  },
  {
    method: 'GET',
    regex: /^\/v1\/incidents\/(\d+)$/,
    auth: 'caller',
    loop: 'off',
    handler: handleGetIncident,
  },
  {
    method: 'POST',
    path: '/v1/processes',
    auth: 'caller',
    loop: 'off',
    handler: handleCreateProcess,
  },
  {
    method: 'GET',
    path: '/v1/processes',
    auth: 'caller',
    loop: 'off',
    handler: handleListProcesses,
  },
  {
    method: 'POST',
    regex: /^\/v1\/processes\/(\d+)\/supersede$/,
    auth: 'caller',
    loop: 'off',
    handler: handleSupersedeProcess,
  },
  {
    method: 'POST',
    regex: /^\/v1\/processes\/(\d+)\/close$/,
    auth: 'caller',
    loop: 'off',
    handler: handleCloseProcess,
  },
  {
    method: 'GET',
    regex: /^\/v1\/processes\/(\d+)$/,
    auth: 'caller',
    loop: 'off',
    handler: handleGetProcess,
  },
  {
    method: 'POST',
    path: '/v1/policies',
    auth: 'caller',
    loop: 'off',
    handler: handleCreatePolicy,
  },
  {
    method: 'GET',
    path: '/v1/policies',
    auth: 'caller',
    loop: 'off',
    handler: handleListPolicies,
  },
  {
    method: 'GET',
    path: '/v1/policies/asof',
    auth: 'caller',
    loop: 'off',
    handler: handlePoliciesAsOf,
  },
  {
    method: 'POST',
    regex: /^\/v1\/policies\/(\d+)\/supersede$/,
    auth: 'caller',
    loop: 'off',
    handler: handleSupersedePolicy,
  },
  {
    method: 'POST',
    regex: /^\/v1\/policies\/(\d+)\/close$/,
    auth: 'caller',
    loop: 'off',
    handler: handleClosePolicy,
  },
  {
    method: 'GET',
    regex: /^\/v1\/policies\/(\d+)$/,
    auth: 'caller',
    loop: 'off',
    handler: handleGetPolicy,
  },
  {
    method: 'POST',
    path: '/v1/skills',
    auth: 'caller',
    loop: 'off',
    handler: handleCreateSkill,
  },
  {
    method: 'GET',
    path: '/v1/skills',
    auth: 'caller',
    loop: 'off',
    handler: handleListSkills,
  },
  {
    method: 'GET',
    path: '/v1/skills/export',
    auth: 'caller',
    loop: 'off',
    handler: handleExportSkills,
  },
  {
    method: 'POST',
    regex: /^\/v1\/skills\/(\d+)\/supersede$/,
    auth: 'caller',
    loop: 'off',
    handler: handleSupersedeSkill,
  },
  {
    method: 'POST',
    regex: /^\/v1\/skills\/(\d+)\/close$/,
    auth: 'caller',
    loop: 'off',
    handler: handleCloseSkill,
  },
  {
    method: 'GET',
    regex: /^\/v1\/skills\/(\d+)$/,
    auth: 'caller',
    loop: 'off',
    handler: handleGetSkill,
  },
  {
    method: 'POST',
    path: '/v1/project-briefs',
    auth: 'caller',
    loop: 'off',
    handler: handleCreateProjectBrief,
  },
  {
    method: 'GET',
    path: '/v1/project-briefs',
    auth: 'caller',
    loop: 'off',
    handler: handleListProjectBriefs,
  },
  {
    method: 'POST',
    path: '/v1/project-briefs/refresh',
    auth: 'caller',
    loop: 'off',
    handler: handleRefreshProjectBrief,
  },
  {
    method: 'POST',
    regex: /^\/v1\/project-briefs\/(\d+)\/supersede$/,
    auth: 'caller',
    loop: 'off',
    handler: handleSupersedeProjectBrief,
  },
  {
    method: 'POST',
    regex: /^\/v1\/project-briefs\/(\d+)\/close$/,
    auth: 'caller',
    loop: 'off',
    handler: handleCloseProjectBrief,
  },
  {
    method: 'GET',
    regex: /^\/v1\/project-briefs\/(\d+)$/,
    auth: 'caller',
    loop: 'off',
    handler: handleGetProjectBrief,
  },
  {
    method: 'POST',
    path: '/v1/customer-notes',
    auth: 'caller',
    loop: 'off',
    handler: handleCreateCustomerNote,
  },
  {
    method: 'GET',
    path: '/v1/customer-notes',
    auth: 'caller',
    loop: 'off',
    handler: handleListCustomerNotes,
  },
  {
    method: 'POST',
    regex: /^\/v1\/customer-notes\/(\d+)\/supersede$/,
    auth: 'caller',
    loop: 'off',
    handler: handleSupersedeCustomerNote,
  },
  {
    method: 'POST',
    regex: /^\/v1\/customer-notes\/(\d+)\/close$/,
    auth: 'caller',
    loop: 'off',
    handler: handleCloseCustomerNote,
  },
  {
    method: 'GET',
    regex: /^\/v1\/customer-notes\/(\d+)$/,
    auth: 'caller',
    loop: 'off',
    handler: handleGetCustomerNote,
  },
  {
    method: 'POST',
    path: '/v1/connectors/slack/events',
    auth: 'webhook-signature',
    loop: 'off',
    handler: webhook(handleSlackEventsWebhook),
  },
  {
    method: 'POST',
    path: '/v1/connectors/github/events',
    auth: 'webhook-signature',
    loop: 'off',
    handler: webhook(handleGitHubEventsWebhook),
  },
];

/** The handler bound to this path's params, or null when the path differs. */
function bindPath<R>(route: RouteEndpoint<R>, path: string): ((r: R) => Promise<void>) | null {
  if ('path' in route) return path === route.path ? route.handler : null;
  if ('pattern' in route) {
    const params = matchPath(route.pattern, path);
    return params ? (r) => route.handler(r, params) : null;
  }
  const match = path.match(route.regex);
  return match ? (r) => route.handler(r, match) : null;
}

/** The route's run for this request, gate first, or null when method or path differ. The matcher runs before the method
 * check, as the inline route blocks did, so a malformed `%` escape still throws from matchPath on any method. */
export function routeMatches(route: Route, method: string, path: string): ((r: RouteRequest) => Promise<void>) | null {
  if (route.auth === 'webhook-signature') {
    const run = bindPath<RouteRequest>(route, path);
    if (run === null || method !== route.method) return null;
    return async (r) => {
      assertRoutePorted(r.opts, routeGroup(route));
      await run(r);
    };
  }
  const run = bindPath<AuthedRouteRequest>(route, path);
  if (run === null || method !== route.method) return null;
  return async (r) => run({ ...r, ctx: await passAuthGate(route, r) });
}

/** The one caller check a gated route passes: sleep refuses a caller off this host before any key work, then one
 * charged auth, then 501 for an unported route, so a bad key is still a 401 there, and the row's role last. */
async function passAuthGate(
  route: Exclude<Route, { auth: 'webhook-signature' }>,
  { req, opts }: RouteRequest,
): Promise<Context> {
  const label = routeLabel(route);
  // Defence in depth, not the boundary: a proxy or a browser page on this host connects from loopback too.
  if (route.auth === 'host-admin-local' && !isLocalCaller(req)) {
    throw new HttpError(403, `${label} is loopback-only (host-wide consolidation; see CHANGELOG v1.11.4)`);
  }
  const ctx = await buildContextWithAuth(req, opts);
  assertRoutePorted(opts, routeGroup(route));
  if (route.auth === 'admin' && ctx.actor.role !== 'admin') throw new HttpError(403, `${label} requires admin role`);
  if (route.auth === 'host-admin-local') assertCrossTenantAdmin(ctx, label);
  return ctx;
}

/** The route as the access line names it; a regex route reads
 * as its pattern would, so no line carries a caller's id. */
export function routeLabel(route: Route): string {
  if ('path' in route) return route.path;
  if ('pattern' in route) return route.pattern;
  return route.regex.source.replace(/^\^|\$$/g, '').replaceAll('\\/', '/').replaceAll('(\\d+)', ':id');
}

const findV1Route = routeLookup(V1_ROUTES, routeMatches);

/** Run the first /v1 route whose method and path match. */
export async function dispatchV1Route(r: RouteRequest, method: string, path: string): Promise<boolean> {
  const match = findV1Route(method, path);
  if (match === null) return false;
  const { route, run } = match;
  noteAccess(r.req, { route: routeLabel(route) });
  // Only a store with worker threads has moved the route's SQLite
  // work; under any other the handler still opens hippo.db itself.
  await (route.loop === 'off' ? r.opts.offLoop(() => run(r)) : run(r));
  return true;
}

/** Core authenticates and parses before the handler runs, so an
 * add-on route gets the same 401, 400 and 501 as a core one. */
export async function dispatchAddonRoute(
  { req, res, opts }: RouteRequest,
  method: string,
  path: string,
): Promise<boolean> {
  const route = method === 'POST' ? opts.routes?.find((r) => r.path === path) : undefined;
  if (!route) return false;
  noteAccess(req, { route: route.path });
  const answer = async (): Promise<void> => {
    const ctx = await buildContextWithAuth(req, opts);
    assertRoutePorted(opts, route.storeReady ?? 'localFiles');
    noteAccess(req, { tenant: ctx.tenantId });
    const body = await parseJsonBody(req, ctx);
    sendJson(res, 200, await route.handler({ ctx, body }));
  };
  // The add-on, not core, knows whether its handler reaches hippo.db only through the store's worker-backed methods.
  await (route.loop === 'off' ? opts.offLoop(answer) : answer());
  return true;
}

/** A route outside /v1 and the add-ons; `loop: 'off'` fences its store work from the server thread as a V1 row's. */
export interface HostRoute {
  readonly method: string;
  readonly path: string;
  readonly loop?: 'off';
}

/** Each runs where boot.ts places it around the rate limit and the request scope. */
export const HOST_ROUTES = {
  health: { method: 'GET', path: '/health', loop: 'off' },
  ready: { method: 'GET', path: '/ready', loop: 'off' },
  mcp: { method: 'POST', path: '/mcp', loop: 'off' },
  mcpStream: { method: 'GET', path: '/mcp/stream', loop: 'off' },
} as const satisfies Readonly<Record<string, HostRoute>>;

/** Runs `handle` when the request is `route`'s, in the fence its row names; false when it is another route. */
export async function dispatchHostRoute(
  { req, opts }: RouteRequest,
  request: { readonly method: string; readonly path: string },
  route: HostRoute,
  handle: () => Promise<void>,
): Promise<boolean> {
  if (request.method !== route.method || request.path !== route.path) return false;
  noteAccess(req, { route: route.path });
  await (route.loop === 'off' ? opts.offLoop(handle) : handle());
  return true;
}

/** No auth, body read or store access, so a caller with no key gets it under any store. */
export function dispatchPublicJson({ req, res, opts }: RouteRequest, method: string, path: string): boolean {
  const text = method === 'GET' ? opts.publicJsonBodies.get(path) : undefined;
  if (text === undefined) return false;
  noteAccess(req, { route: path });
  res.writeHead(200, { ...JSON_HEADERS, 'cache-control': 'no-store' });
  res.end(text);
  return true;
}

/** The group a row needs: a sqliteOnly row needs hippo.db's local files, a row naming none runs on any store. */
function routeGroup(route: Route): StoreGroup | undefined {
  return route.sqliteOnly === undefined ? route.storeReady : 'localFiles';
}

/** A route answers 501 without running when the store lacks the group it needs. */
function assertRoutePorted(opts: ResolvedServeOptions, group: StoreGroup | undefined): void {
  if (group !== undefined && !hasGroup(opts.store, group)) throw new HttpError(501, STORE_NOT_PORTED_MESSAGE);
}
