import type { Context } from '../../api/index.js';
import { handleGitHubEventsWebhook } from '../connectors/github/webhook.js';
import { handleSlackEventsWebhook } from '../connectors/slack/webhook.js';
import type { HippoStore } from '../../store/index.js';
import { storeMeets, type StoreNeed } from '../../store/local/index.js';
import type { HippoConfig } from '../../base/config/config.js';
import {
  HttpError,
  JSON_HEADERS,
  STORE_NOT_PORTED_MESSAGE,
  sendJson,
  type WebhookRequest,
} from '../../base/util/http-util.js';
import { assertCrossTenantAdmin, buildContextWithAuth, isLocalCaller } from './auth.js';
import { INT_PARAM, matchPath, noteAccess } from './request.js';
import { routeLookup } from './route-lookup.js';
import {
  handleApproveQuarantine,
  handleCreateAuthKey,
  handleListAudit,
  handleListAuthKeys,
  handleListQuarantine,
  handleRejectQuarantine,
  handleRevokeAuthKey,
} from './routes/admin.js';
import {
  handleApplyOutcome,
  handleArchiveMemory,
  handleCreateMemory,
  handleForgetMemory,
  handleGetGraph,
  handlePromoteMemory,
  handleSleep,
  handleSupersedeMemory,
} from './routes/memories.js';
import { kindRows } from './routes/kind-routes.js';
import { objectRoutes, versionedRoutes } from './routes/object-routes.js';
import { CUSTOMER_NOTE_ROUTES } from './routes/customer-notes.js';
import { DECISION_ROUTES } from './routes/decisions.js';
import { INCIDENT_ROUTES } from './routes/incidents.js';
import { POLICY_ROUTES } from './routes/policies.js';
import { PREDICTION_ROUTES } from './routes/predictions.js';
import { PROCESS_ROUTES } from './routes/processes.js';
import { PROJECT_BRIEF_ROUTES } from './routes/project-briefs.js';
import { SKILL_ROUTES } from './routes/skills.js';
import { handleAssembleSession, handleDrillRecall, handleGetContext, handleRecallMemories } from './routes/recall.js';
import { parseJsonBody } from './validation.js';
import type { AuthedRouteRequest, ResolvedServeOptions, Route, RouteRequest, RouteEndpoint } from './types.js';

function webhook(
  handle: (r: WebhookRequest, store: HippoStore, config: HippoConfig) => Promise<void>,
): (r: RouteRequest) => Promise<void> {
  return async ({ req, res, opts }) => {
    await handle({ req, res, opts }, opts.store, opts.configAt(opts.hippoRoot));
  };
}

/** The /v1 routes in dispatch order; the first entry whose method and path match handles the request. Each row's `auth`
 * is what the dispatch gate proves before its handler runs, so a handler never checks the caller itself. */
export const V1_ROUTES: readonly Route[] = [
  {
    method: 'POST',
    path: '/v1/memories',
    auth: 'caller',
    handler: handleCreateMemory,
  },
  {
    method: 'GET',
    path: '/v1/graph',
    auth: 'caller',
    handler: handleGetGraph,
  },
  {
    method: 'GET',
    path: '/v1/memories',
    auth: 'caller',
    handler: handleRecallMemories,
  },
  {
    method: 'GET',
    pattern: '/v1/sessions/:id/assemble',
    auth: 'caller',
    handler: handleAssembleSession,
  },
  {
    method: 'GET',
    pattern: '/v1/recall/drill/:id',
    auth: 'caller',
    handler: handleDrillRecall,
  },
  {
    method: 'POST',
    pattern: '/v1/memories/:id/archive',
    auth: 'caller',
    handler: handleArchiveMemory,
  },
  {
    method: 'POST',
    pattern: '/v1/memories/:id/supersede',
    auth: 'caller',
    handler: handleSupersedeMemory,
  },
  {
    method: 'POST',
    pattern: '/v1/memories/:id/promote',
    auth: 'caller',
    // The copy names its source folder and goes to the operator's global store, which only a folder store reaches.
    storeReady: 'folderFiles',
    handler: handlePromoteMemory,
  },
  {
    method: 'DELETE',
    pattern: '/v1/memories/:id',
    auth: 'caller',
    handler: handleForgetMemory,
  },
  {
    method: 'POST',
    path: '/v1/outcome',
    auth: 'caller',
    handler: handleApplyOutcome,
  },
  {
    method: 'GET',
    path: '/v1/context',
    auth: 'caller',
    handler: handleGetContext,
  },
  {
    method: 'POST',
    path: '/v1/sleep',
    auth: 'host-admin-local',
    storeReady: 'localFiles',
    handler: handleSleep,
  },
  {
    method: 'POST',
    path: '/v1/auth/keys',
    auth: 'admin',
    handler: handleCreateAuthKey,
  },
  {
    method: 'GET',
    path: '/v1/auth/keys',
    auth: 'caller',
    handler: handleListAuthKeys,
  },
  {
    method: 'DELETE',
    pattern: '/v1/auth/keys/:keyId',
    auth: 'caller',
    handler: handleRevokeAuthKey,
  },
  {
    method: 'GET',
    path: '/v1/quarantine',
    auth: 'admin',
    handler: handleListQuarantine,
  },
  {
    method: 'POST',
    pattern: '/v1/quarantine/:id/approve',
    auth: 'admin',
    handler: handleApproveQuarantine,
  },
  {
    method: 'POST',
    pattern: '/v1/quarantine/:id/reject',
    auth: 'admin',
    handler: handleRejectQuarantine,
  },
  {
    method: 'GET',
    path: '/v1/audit',
    auth: 'admin',
    handler: handleListAudit,
  },
  ...kindRows(PREDICTION_ROUTES),
  ...objectRoutes(DECISION_ROUTES),
  ...objectRoutes(INCIDENT_ROUTES),
  ...versionedRoutes(PROCESS_ROUTES),
  ...versionedRoutes(POLICY_ROUTES),
  ...versionedRoutes(SKILL_ROUTES),
  ...versionedRoutes(PROJECT_BRIEF_ROUTES),
  ...versionedRoutes(CUSTOMER_NOTE_ROUTES),
  {
    method: 'POST',
    path: '/v1/connectors/slack/events',
    auth: 'webhook-signature',
    handler: webhook(handleSlackEventsWebhook),
  },
  {
    method: 'POST',
    path: '/v1/connectors/github/events',
    auth: 'webhook-signature',
    handler: webhook(handleGitHubEventsWebhook),
  },
];

/** The handler bound to this path's params, or null when the path differs. */
export function bindPath<R>(route: RouteEndpoint<R>, path: string): ((r: R) => Promise<void>) | null {
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

/** The route as the access line names it: params by name without their type, so no line carries a caller's id. */
export function routeLabel(route: RouteEndpoint<never>): string {
  if ('path' in route) return route.path;
  if ('pattern' in route) return route.pattern.replaceAll(INT_PARAM, '');
  return route.regex.source.replace(/^\^|\$$/g, '').replaceAll('\\/', '/');
}

const findV1Route = routeLookup(V1_ROUTES, routeMatches);

/** Run the first /v1 route whose method and path match. */
export async function dispatchV1Route(r: RouteRequest, method: string, path: string): Promise<boolean> {
  const match = findV1Route(method, path);
  if (match === null) return false;
  const { route, run } = match;
  noteAccess(r.req, { route: routeLabel(route) });
  // Only a store with worker threads has moved the route's SQLite work; under any other the handler still opens
  // hippo.db itself.
  await r.opts.offLoop(() => run(r));
  return true;
}

/** Core authenticates and parses before the handler runs, so an add-on route gets the same 401, 400 and 501 as a core
 * one. */
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

/** A route outside /v1 and the add-ons; its store work runs off the server thread as a V1 row's does. */
export interface HostRoute {
  readonly method: string;
  readonly path: string;
}

/** Each runs where boot.ts places it around the rate limit and the request scope. */
export const HOST_ROUTES = {
  health: { method: 'GET', path: '/health' },
  ready: { method: 'GET', path: '/ready' },
  mcp: { method: 'POST', path: '/mcp' },
  mcpStream: { method: 'GET', path: '/mcp/stream' },
} as const satisfies Readonly<Record<string, HostRoute>>;

/** Runs `handle` off the server thread when the request is `route`'s; false when it is another route. */
export async function dispatchHostRoute(
  { req, opts }: RouteRequest,
  request: { readonly method: string; readonly path: string },
  route: HostRoute,
  handle: () => Promise<void>,
): Promise<boolean> {
  if (request.method !== route.method || request.path !== route.path) return false;
  noteAccess(req, { route: route.path });
  await opts.offLoop(handle);
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

/** What a row needs: a sqliteOnly row needs hippo.db's local files, a row naming none runs on any store. */
function routeGroup(route: Route): StoreNeed | undefined {
  return route.sqliteOnly === undefined ? route.storeReady : 'localFiles';
}

/** A route answers 501 without running when the store lacks what it needs. */
function assertRoutePorted(opts: ResolvedServeOptions, need: StoreNeed | undefined): void {
  if (need !== undefined && !storeMeets(opts.store, need)) throw new HttpError(501, STORE_NOT_PORTED_MESSAGE);
}
