import type { IncomingMessage } from 'node:http';
import { hasGroup, type StoreGroup } from '../store-port.js';
import { HttpError, JSON_HEADERS, sendJson, STORE_NOT_PORTED_MESSAGE } from '../http-util.js';
import { buildContextWithAuth, requireAuth } from './auth.js';
import { matchPath } from './request.js';
import { handleApproveQuarantine, handleCreateAuthKey, handleListAudit, handleListAuthKeys, handleListQuarantine, handleRejectQuarantine, handleRevokeAuthKey } from './routes/admin.js';
import { handleCloseCustomerNote, handleCreateCustomerNote, handleGetCustomerNote, handleListCustomerNotes, handleSupersedeCustomerNote } from './routes/customer-notes.js';
import { handleCloseDecision, handleCreateDecision, handleGetDecision, handleListDecisions, handleSupersedeDecision } from './routes/decisions.js';
import { handleCloseIncident, handleCreateIncident, handleGetIncident, handleListIncidents, handleResolveIncident } from './routes/incidents.js';
import { handleApplyOutcome, handleArchiveMemory, handleCreateMemory, handleForgetMemory, handleGetGraph, handlePromoteMemory, handleSleep, handleSupersedeMemory } from './routes/memories.js';
import { handleClosePolicy, handleCreatePolicy, handleGetPolicy, handleListPolicies, handlePoliciesAsOf, handleSupersedePolicy } from './routes/policies.js';
import { handleClosePrediction, handleCreatePrediction, handleGetPrediction, handleListPredictions, handlePredictionStats } from './routes/predictions.js';
import { handleCloseProcess, handleCreateProcess, handleGetProcess, handleListProcesses, handleSupersedeProcess } from './routes/processes.js';
import { handleCloseProjectBrief, handleCreateProjectBrief, handleGetProjectBrief, handleListProjectBriefs, handleRefreshProjectBrief, handleSupersedeProjectBrief } from './routes/project-briefs.js';
import { handleAssembleSession, handleDrillRecall, handleGetContext, handleRecallMemories } from './routes/recall.js';
import { handleCloseSkill, handleCreateSkill, handleExportSkills, handleGetSkill, handleListSkills, handleSupersedeSkill } from './routes/skills.js';
import { parseJsonBody } from './validation.js';
import type { AddonRoute, ResolvedServeOpts, Route, RouteRequest } from './types.js';
import type { JsonValue } from '../json.js';

// Review patch #2: explicit allow-list for unauthenticated /v1/* routes.
// New unauth routes MUST be added here AND get a corresponding entry in
// tests/server-bearer-lockdown.test.ts. Do not gate auth elsewhere by
// `path.startsWith` — pattern-positional auth is bypass-by-accident.
//
// The route handlers consult `isPublicRoute` before invoking
// `buildContextWithAuth` / `requireAuth`. Adding a route here without
// adding the corresponding `isPublicRoute` short-circuit in a handler is
// a no-op (auth still applies), so the failure mode is fail-closed.
// The only other unauthenticated paths are ServeOpts.publicJson's: GET only, checked at boot by assertPublicJson.
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'POST /v1/connectors/slack/events',
  'POST /v1/connectors/github/events',
]);

export function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.has(`${method} ${path}`);
}

/** The /v1 routes in dispatch order; the first entry whose method and path match handles the request. */
const V1_ROUTES: readonly Route[] = [
  { method: 'POST', path: '/v1/memories', storeReady: 'entryWrites', handler: handleCreateMemory },
  { method: 'GET', path: '/v1/graph', handler: handleGetGraph },
  { method: 'GET', path: '/v1/memories', storeReady: 'base', handler: handleRecallMemories },
  { method: 'GET', pattern: '/v1/sessions/:id/assemble', storeReady: 'dagReads', handler: handleAssembleSession },
  { method: 'GET', pattern: '/v1/recall/drill/:id', storeReady: 'dagReads', handler: handleDrillRecall },
  { method: 'POST', pattern: '/v1/memories/:id/archive', storeReady: 'entryWrites', handler: handleArchiveMemory },
  { method: 'POST', pattern: '/v1/memories/:id/supersede', storeReady: 'entryWrites', handler: handleSupersedeMemory },
  { method: 'POST', pattern: '/v1/memories/:id/promote', sqliteOnly: 'copies a memory between the two local hippo.db files', handler: handlePromoteMemory },
  { method: 'DELETE', pattern: '/v1/memories/:id', storeReady: 'entryWrites', handler: handleForgetMemory },
  { method: 'POST', path: '/v1/outcome', storeReady: 'entryWrites', handler: handleApplyOutcome },
  { method: 'GET', path: '/v1/context', storeReady: 'contextReads', handler: handleGetContext },
  { method: 'POST', path: '/v1/sleep', sqliteOnly: 'consolidates every tenant under the local hippo root in this process', handler: handleSleep },
  { method: 'POST', path: '/v1/auth/keys', storeReady: 'keyWrites', handler: handleCreateAuthKey },
  { method: 'GET', path: '/v1/auth/keys', storeReady: 'keyWrites', handler: handleListAuthKeys },
  { method: 'DELETE', pattern: '/v1/auth/keys/:keyId', storeReady: 'keyAudit', handler: handleRevokeAuthKey },
  { method: 'GET', path: '/v1/quarantine', handler: handleListQuarantine },
  { method: 'POST', pattern: '/v1/quarantine/:id/approve', handler: handleApproveQuarantine },
  { method: 'POST', pattern: '/v1/quarantine/:id/reject', handler: handleRejectQuarantine },
  { method: 'GET', path: '/v1/audit', storeReady: 'auditLog', handler: handleListAudit },
  { method: 'POST', path: '/v1/predictions', storeReady: 'predictions', handler: handleCreatePrediction },
  { method: 'GET', path: '/v1/predictions', storeReady: 'predictions', handler: handleListPredictions },
  { method: 'GET', path: '/v1/predictions/stats', storeReady: 'predictions', handler: handlePredictionStats },
  { method: 'GET', regex: /^\/v1\/predictions\/(\d+)$/, storeReady: 'predictions', handler: handleGetPrediction },
  { method: 'POST', regex: /^\/v1\/predictions\/(\d+)\/close$/, storeReady: 'predictions', handler: handleClosePrediction },
  { method: 'POST', path: '/v1/decisions', handler: handleCreateDecision },
  { method: 'GET', path: '/v1/decisions', handler: handleListDecisions },
  { method: 'POST', regex: /^\/v1\/decisions\/(\d+)\/supersede$/, handler: handleSupersedeDecision },
  { method: 'POST', regex: /^\/v1\/decisions\/(\d+)\/close$/, handler: handleCloseDecision },
  { method: 'GET', regex: /^\/v1\/decisions\/(\d+)$/, handler: handleGetDecision },
  { method: 'POST', path: '/v1/incidents', handler: handleCreateIncident },
  { method: 'GET', path: '/v1/incidents', handler: handleListIncidents },
  { method: 'POST', regex: /^\/v1\/incidents\/(\d+)\/resolve$/, handler: handleResolveIncident },
  { method: 'POST', regex: /^\/v1\/incidents\/(\d+)\/close$/, handler: handleCloseIncident },
  { method: 'GET', regex: /^\/v1\/incidents\/(\d+)$/, handler: handleGetIncident },
  { method: 'POST', path: '/v1/processes', handler: handleCreateProcess },
  { method: 'GET', path: '/v1/processes', handler: handleListProcesses },
  { method: 'POST', regex: /^\/v1\/processes\/(\d+)\/supersede$/, handler: handleSupersedeProcess },
  { method: 'POST', regex: /^\/v1\/processes\/(\d+)\/close$/, handler: handleCloseProcess },
  { method: 'GET', regex: /^\/v1\/processes\/(\d+)$/, handler: handleGetProcess },
  { method: 'POST', path: '/v1/policies', handler: handleCreatePolicy },
  { method: 'GET', path: '/v1/policies', handler: handleListPolicies },
  { method: 'GET', path: '/v1/policies/asof', handler: handlePoliciesAsOf },
  { method: 'POST', regex: /^\/v1\/policies\/(\d+)\/supersede$/, handler: handleSupersedePolicy },
  { method: 'POST', regex: /^\/v1\/policies\/(\d+)\/close$/, handler: handleClosePolicy },
  { method: 'GET', regex: /^\/v1\/policies\/(\d+)$/, handler: handleGetPolicy },
  { method: 'POST', path: '/v1/skills', handler: handleCreateSkill },
  { method: 'GET', path: '/v1/skills', handler: handleListSkills },
  { method: 'GET', path: '/v1/skills/export', handler: handleExportSkills },
  { method: 'POST', regex: /^\/v1\/skills\/(\d+)\/supersede$/, handler: handleSupersedeSkill },
  { method: 'POST', regex: /^\/v1\/skills\/(\d+)\/close$/, handler: handleCloseSkill },
  { method: 'GET', regex: /^\/v1\/skills\/(\d+)$/, handler: handleGetSkill },
  { method: 'POST', path: '/v1/project-briefs', handler: handleCreateProjectBrief },
  { method: 'GET', path: '/v1/project-briefs', handler: handleListProjectBriefs },
  { method: 'POST', path: '/v1/project-briefs/refresh', handler: handleRefreshProjectBrief },
  { method: 'POST', regex: /^\/v1\/project-briefs\/(\d+)\/supersede$/, handler: handleSupersedeProjectBrief },
  { method: 'POST', regex: /^\/v1\/project-briefs\/(\d+)\/close$/, handler: handleCloseProjectBrief },
  { method: 'GET', regex: /^\/v1\/project-briefs\/(\d+)$/, handler: handleGetProjectBrief },
  { method: 'POST', path: '/v1/customer-notes', handler: handleCreateCustomerNote },
  { method: 'GET', path: '/v1/customer-notes', handler: handleListCustomerNotes },
  { method: 'POST', regex: /^\/v1\/customer-notes\/(\d+)\/supersede$/, handler: handleSupersedeCustomerNote },
  { method: 'POST', regex: /^\/v1\/customer-notes\/(\d+)\/close$/, handler: handleCloseCustomerNote },
  { method: 'GET', regex: /^\/v1\/customer-notes\/(\d+)$/, handler: handleGetCustomerNote },
];

/** The route's handler bound to this request's path params, or null when method or path differ. The matcher runs before the
 *  method check, as the inline route blocks did, so a malformed `%` escape still throws from matchPath on any method. */
function routeMatches(route: Route, method: string, path: string): ((r: RouteRequest) => Promise<void>) | null {
  if ('path' in route) return method === route.method && path === route.path ? route.handler : null;
  if ('pattern' in route) {
    const params = matchPath(route.pattern, path);
    return method === route.method && params ? (r) => route.handler(r, params) : null;
  }
  const match = path.match(route.regex);
  return method === route.method && match ? (r) => route.handler(r, match) : null;
}

/** Run the first /v1 route whose method and path match. */
export async function dispatchV1Route(r: RouteRequest, method: string, path: string): Promise<boolean> {
  for (const route of V1_ROUTES) {
    const run = routeMatches(route, method, path);
    if (run === null) continue;
    await refuseUnportedRoute(r.req, r.opts, route.storeReady, route.sqliteOnly);
    await run(r);
    return true;
  }
  return false;
}

const PLAIN_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;

function isPlainV1Path(path: string): boolean {
  return path.startsWith('/v1/') && new URL(path, 'http://h').pathname === path
    && path.slice('/v1/'.length).split('/').every((segment) => PLAIN_SEGMENT_RE.test(segment));
}

// A plain path never holds a `%`, so matchPath cannot throw here.
function isCorePath(method: string, path: string): boolean {
  return PUBLIC_ROUTES.has(`${method} ${path}`) || V1_ROUTES.some((route) => routeMatches(route, method, path) !== null);
}

/** Boot-time check: an add-on path must be plain, unique and not one core serves, so no add-on shadows a core route or hides from dispatch. */
export function assertAddonRoutes(routes: readonly AddonRoute[]): void {
  const seen = new Set<string>();
  for (const { path } of routes) {
    if (!isPlainV1Path(path)) throw new Error(`add-on route '${path}' is not a plain /v1/ path (segments use A-Z a-z 0-9 . _ ~ -)`);
    if (seen.has(path)) throw new Error(`add-on route '${path}' is registered twice`);
    if (isCorePath('POST', path)) throw new Error(`add-on route '${path}' is already served by core`);
    seen.add(path);
  }
}

const PUBLIC_JSON_MAX_BYTES = 64 * 1024;

/** Boot-time check and serialization: a public path that a core GET route serves would open that route to anyone. */
export function assertPublicJson(publicJson: Readonly<Record<string, JsonValue>>): ReadonlyMap<string, string> {
  const bodies = new Map<string, string>();
  for (const [path, value] of Object.entries(publicJson)) {
    if (!isPlainV1Path(path)) throw new Error(`public JSON path '${path}' is not a plain /v1/ path (segments use A-Z a-z 0-9 . _ ~ -)`);
    if (isCorePath('GET', path)) throw new Error(`public JSON path '${path}' is already served by core`);
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error(`public JSON at '${path}' is not JSON`);
    if (Buffer.byteLength(text) > PUBLIC_JSON_MAX_BYTES) throw new Error(`public JSON at '${path}' is over 64 KiB`);
    bodies.set(path, text);
  }
  return bodies;
}

/** Core authenticates and parses before the handler runs, so an add-on route gets the same 401, 400 and 501 as a core one. */
export async function dispatchAddonRoute({ req, res, opts }: RouteRequest, method: string, path: string): Promise<boolean> {
  const route = method === 'POST' ? opts.routes?.find((r) => r.path === path) : undefined;
  if (!route) return false;
  await refuseUnportedRoute(req, opts, route.storeReady);
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  sendJson(res, 200, await route.handler({ ctx, body }));
  return true;
}

/** No auth, body read or store access, so a caller with no key gets it under any store. */
export function dispatchPublicJson({ res, opts }: RouteRequest, method: string, path: string): boolean {
  const text = method === 'GET' ? opts.publicJsonBodies.get(path) : undefined;
  if (text === undefined) return false;
  res.writeHead(200, { ...JSON_HEADERS, 'cache-control': 'no-store' });
  res.end(text);
  return true;
}

export function assertSqliteStore(opts: ResolvedServeOpts, sqliteOnlyReason?: string): void {
  if (opts.store.kind !== 'sqlite') throw new HttpError(501, sqliteOnlyReason === undefined ? STORE_NOT_PORTED_MESSAGE : `${STORE_NOT_PORTED_MESSAGE}: ${sqliteOnlyReason}`);
}

/** Under another store, a route that names no group, or one the store lacks, answers 501 without running (a sqliteOnly route adds its reason); the caller is checked first, so a bad key is still a 401. */
async function refuseUnportedRoute(req: IncomingMessage, opts: ResolvedServeOpts, group?: StoreGroup, sqliteOnlyReason?: string): Promise<void> {
  if (opts.store.kind === 'sqlite' || (group !== undefined && hasGroup(opts.store, group))) return;
  await requireAuth(req, opts);
  assertSqliteStore(opts, sqliteOnlyReason);
}
