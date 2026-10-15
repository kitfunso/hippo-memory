import { narrowContext, type StoreContext } from '../api/index.js';
import { handleGitHubEventsWebhook } from '../connectors/github/webhook.js';
import type { ConnectorStore } from '../connectors/store.js';
import { handleSlackEventsWebhook } from '../connectors/slack/webhook.js';
import { hasGroup, narrowStore, type StoreGroup } from '../store/index.js';
import { HttpError, JSON_HEADERS, sendJson, STORE_NOT_PORTED_MESSAGE, type WebhookRequest } from '../util/http-util.js';
import { assertCrossTenantAdmin, buildContextWithAuth, isLoopback } from './auth.js';
import { matchPath, noteAccess } from './request.js';
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
import type { AuthedRouteRequest, ResolvedServeOpts, Route, RouteOf, RouteRequest, RouteEndpoint } from './types.js';

const WEBHOOK_GROUPS = ['entryWrites', 'connectorWrites', 'connectorEvents'] as const;

/** A store missing a group a delivery writes through refuses the webhook up front, so no delivery is acknowledged
 * and then half stored. */
function webhook(
  handle: (r: WebhookRequest, store: ConnectorStore) => Promise<void>,
): (r: RouteRequest) => Promise<void> {
  return async ({ req, res, opts }) => {
    await handle({ req, res, opts }, narrowStore(opts.store, ...WEBHOOK_GROUPS));
  };
}

/** A handler that gets its request with the ctx narrowed to `group`, which the dispatch gate has already proved. */
function narrowed<G extends StoreGroup, A extends unknown[]>(
  group: G,
  handler: (r: AuthedRouteRequest<G>, ...rest: A) => Promise<void>,
): (r: AuthedRouteRequest, ...rest: A) => Promise<void> {
  return (r, ...rest) => handler({ ...r, ctx: narrowContext(r.ctx, group) }, ...rest);
}

/** One table row: the handler's group must be the row's `storeReady` (a row naming none needs `localFiles`), so a
 * handler cannot reach a group its gate never checked. */
function defineRoute<G extends StoreGroup = 'localFiles'>(route: RouteOf<G>): Route {
  if (route.auth === 'webhook-signature') return route;
  // SAFETY: a row that names no group only exists while G is its 'localFiles' default.
  const group = (route.storeReady ?? 'localFiles') as G;
  // SAFETY: the three endpoint shapes differ only in the extra argument the dispatch passes, which `narrowed` forwards.
  const handler = route.handler as (r: AuthedRouteRequest<G>, ...rest: unknown[]) => Promise<void>;
  // SAFETY: the spread keeps the row's endpoint key, and the handler differs from it only by the narrowing wrapper.
  return { ...route, handler: narrowed(group, handler) } as Route;
}

/** The /v1 routes in dispatch order; the first entry whose method and path match handles the request. Each row's `auth`
 * is what the dispatch gate proves before its handler runs, so a handler never checks the caller itself. */
export const V1_ROUTES: readonly Route[] = [
  defineRoute({
    method: 'POST',
    path: '/v1/memories',
    auth: 'caller',
    storeReady: 'entryWrites',
    loop: 'off',
    handler: handleCreateMemory,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/graph',
    auth: 'caller',
    storeReady: 'graphReads',
    loop: 'off',
    handler: handleGetGraph,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/memories',
    auth: 'caller',
    storeReady: 'base',
    loop: 'off',
    handler: handleRecallMemories,
  }),
  defineRoute({
    method: 'GET',
    pattern: '/v1/sessions/:id/assemble',
    auth: 'caller',
    storeReady: 'dagReads',
    loop: 'off',
    handler: handleAssembleSession,
  }),
  defineRoute({
    method: 'GET',
    pattern: '/v1/recall/drill/:id',
    auth: 'caller',
    storeReady: 'dagReads',
    handler: handleDrillRecall,
  }),
  defineRoute({
    method: 'POST',
    pattern: '/v1/memories/:id/archive',
    auth: 'caller',
    storeReady: 'entryWrites',
    loop: 'off',
    handler: handleArchiveMemory,
  }),
  defineRoute({
    method: 'POST',
    pattern: '/v1/memories/:id/supersede',
    auth: 'caller',
    storeReady: 'entryWrites',
    loop: 'off',
    handler: handleSupersedeMemory,
  }),
  defineRoute({
    method: 'POST',
    pattern: '/v1/memories/:id/promote',
    auth: 'caller',
    storeReady: 'localFiles',
    handler: handlePromoteMemory,
  }),
  defineRoute({
    method: 'DELETE',
    pattern: '/v1/memories/:id',
    auth: 'caller',
    storeReady: 'entryWrites',
    loop: 'off',
    handler: handleForgetMemory,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/outcome',
    auth: 'caller',
    storeReady: 'entryWrites',
    handler: handleApplyOutcome,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/context',
    auth: 'caller',
    storeReady: 'contextReads',
    handler: handleGetContext,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/sleep',
    auth: 'host-admin-local',
    storeReady: 'localFiles',
    handler: handleSleep,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/auth/keys',
    auth: 'caller',
    storeReady: 'keyWrites',
    loop: 'off',
    handler: handleCreateAuthKey,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/auth/keys',
    auth: 'caller',
    storeReady: 'keyWrites',
    loop: 'off',
    handler: handleListAuthKeys,
  }),
  defineRoute({
    method: 'DELETE',
    pattern: '/v1/auth/keys/:keyId',
    auth: 'caller',
    storeReady: 'keyAudit',
    loop: 'off',
    handler: handleRevokeAuthKey,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/quarantine',
    auth: 'admin',
    storeReady: 'quarantine',
    loop: 'off',
    handler: handleListQuarantine,
  }),
  defineRoute({
    method: 'POST',
    pattern: '/v1/quarantine/:id/approve',
    auth: 'admin',
    storeReady: 'quarantine',
    loop: 'off',
    handler: handleApproveQuarantine,
  }),
  defineRoute({
    method: 'POST',
    pattern: '/v1/quarantine/:id/reject',
    auth: 'admin',
    storeReady: 'quarantine',
    loop: 'off',
    handler: handleRejectQuarantine,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/audit',
    auth: 'admin',
    storeReady: 'auditLog',
    loop: 'off',
    handler: handleListAudit,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/predictions',
    auth: 'caller',
    storeReady: 'predictions',
    loop: 'off',
    handler: handleCreatePrediction,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/predictions',
    auth: 'caller',
    storeReady: 'predictions',
    loop: 'off',
    handler: handleListPredictions,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/predictions/stats',
    auth: 'caller',
    storeReady: 'predictions',
    loop: 'off',
    handler: handlePredictionStats,
  }),
  defineRoute({
    method: 'GET',
    regex: /^\/v1\/predictions\/(\d+)$/,
    auth: 'caller',
    storeReady: 'predictions',
    loop: 'off',
    handler: handleGetPrediction,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/predictions\/(\d+)\/close$/,
    auth: 'caller',
    storeReady: 'predictions',
    loop: 'off',
    handler: handleClosePrediction,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/decisions',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCreateDecision,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/decisions',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleListDecisions,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/decisions\/(\d+)\/supersede$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleSupersedeDecision,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/decisions\/(\d+)\/close$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCloseDecision,
  }),
  defineRoute({
    method: 'GET',
    regex: /^\/v1\/decisions\/(\d+)$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleGetDecision,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/incidents',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCreateIncident,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/incidents',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleListIncidents,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/incidents\/(\d+)\/resolve$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleResolveIncident,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/incidents\/(\d+)\/close$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCloseIncident,
  }),
  defineRoute({
    method: 'GET',
    regex: /^\/v1\/incidents\/(\d+)$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleGetIncident,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/processes',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCreateProcess,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/processes',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleListProcesses,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/processes\/(\d+)\/supersede$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleSupersedeProcess,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/processes\/(\d+)\/close$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCloseProcess,
  }),
  defineRoute({
    method: 'GET',
    regex: /^\/v1\/processes\/(\d+)$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleGetProcess,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/policies',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCreatePolicy,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/policies',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleListPolicies,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/policies/asof',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handlePoliciesAsOf,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/policies\/(\d+)\/supersede$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleSupersedePolicy,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/policies\/(\d+)\/close$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleClosePolicy,
  }),
  defineRoute({
    method: 'GET',
    regex: /^\/v1\/policies\/(\d+)$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleGetPolicy,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/skills',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCreateSkill,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/skills',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleListSkills,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/skills/export',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleExportSkills,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/skills\/(\d+)\/supersede$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleSupersedeSkill,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/skills\/(\d+)\/close$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCloseSkill,
  }),
  defineRoute({
    method: 'GET',
    regex: /^\/v1\/skills\/(\d+)$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleGetSkill,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/project-briefs',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCreateProjectBrief,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/project-briefs',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleListProjectBriefs,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/project-briefs/refresh',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleRefreshProjectBrief,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/project-briefs\/(\d+)\/supersede$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleSupersedeProjectBrief,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/project-briefs\/(\d+)\/close$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCloseProjectBrief,
  }),
  defineRoute({
    method: 'GET',
    regex: /^\/v1\/project-briefs\/(\d+)$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleGetProjectBrief,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/customer-notes',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCreateCustomerNote,
  }),
  defineRoute({
    method: 'GET',
    path: '/v1/customer-notes',
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleListCustomerNotes,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/customer-notes\/(\d+)\/supersede$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleSupersedeCustomerNote,
  }),
  defineRoute({
    method: 'POST',
    regex: /^\/v1\/customer-notes\/(\d+)\/close$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleCloseCustomerNote,
  }),
  defineRoute({
    method: 'GET',
    regex: /^\/v1\/customer-notes\/(\d+)$/,
    auth: 'caller',
    storeReady: 'objects',
    loop: 'off',
    handler: handleGetCustomerNote,
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/connectors/slack/events',
    auth: 'webhook-signature',
    storeReady: 'connectorEvents',
    handler: webhook(handleSlackEventsWebhook),
  }),
  defineRoute({
    method: 'POST',
    path: '/v1/connectors/github/events',
    auth: 'webhook-signature',
    storeReady: 'connectorEvents',
    handler: webhook(handleGitHubEventsWebhook),
  }),
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
      assertRoutePorted(r.opts, route.storeReady);
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
): Promise<StoreContext> {
  const label = routeLabel(route);
  // Defence in depth, not the boundary: a socket address says where a request came from, never who sent it.
  if (route.auth === 'host-admin-local' && !isLoopback(req.socket.remoteAddress)) {
    throw new HttpError(403, `${label} is loopback-only (host-wide consolidation; see CHANGELOG v1.11.4)`);
  }
  const ctx = await buildContextWithAuth(req, opts);
  assertRoutePorted(opts, route.storeReady);
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

/** Run the first /v1 route whose method and path match. */
export async function dispatchV1Route(r: RouteRequest, method: string, path: string): Promise<boolean> {
  for (const route of V1_ROUTES) {
    const run = routeMatches(route, method, path);
    if (run === null) continue;
    noteAccess(r.req, { route: routeLabel(route) });
    // Only a store with worker threads has moved the route's SQLite
    // work; under any other the handler still opens hippo.db itself.
    await (route.loop === 'off' ? r.opts.offLoop(() => run(r)) : run(r));
    return true;
  }
  return false;
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
  const ctx = await buildContextWithAuth(req, opts);
  assertRoutePorted(opts, route.storeReady);
  noteAccess(req, { tenant: ctx.tenantId });
  const body = await parseJsonBody(req, ctx);
  sendJson(res, 200, await route.handler({ ctx, body }));
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

/** A route answers 501 without running when the store lacks its group; a route that names none, a sqliteOnly one
 * among them, needs hippo.db's local files. */
function assertRoutePorted(opts: ResolvedServeOpts, group: StoreGroup = 'localFiles'): void {
  if (!hasGroup(opts.store, group)) throw new HttpError(501, STORE_NOT_PORTED_MESSAGE);
}
