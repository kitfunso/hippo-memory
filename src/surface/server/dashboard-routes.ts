// The dashboard's route table and its dispatch: the /v1 rows' shape and lookup, behind the dashboard session.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestLimits } from '../../base/util/request-scope.js';
import {
  cardRoute,
  cardsRoute,
  forgetRoute,
  memoryPageRoute,
  memoryRoute,
  overviewRoute,
  pinRoute,
  projectRoute,
  resolveRoute,
  searchRoute,
  wrongRoute,
} from '../dashboard/dashboard.js';
import { pageRoute, SECURITY_HEADERS } from '../dashboard/dashboard-page.js';
import type { StaticFiles } from '../dashboard/static-file.js';
import type { DashboardReader } from './dashboard-reader.js';
import { passDashboardSession, type DashboardAccess, type DashboardSession } from './dashboard-session.js';
import type { DashboardContext, DashboardRoute, DashboardRouteRequest } from './dashboard-types.js';
import { noteAccess, parseRequest, sendError } from './request.js';
import { routeLookup } from './route-lookup.js';
import { bindPath, routeLabel } from './route-table.js';

const SESSION = 'dashboard-session';
// Every path outside the JSON API is the app's: it routes in the browser, so any of them may be a page load.
const PAGE = /^\/(?!api\/).*$/;

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  { method: 'GET', path: '/api/overview', auth: SESSION, handler: overviewRoute },
  { method: 'GET', pattern: '/api/projects/:key/memories', auth: SESSION, handler: memoryPageRoute },
  { method: 'GET', pattern: '/api/projects/:key', auth: SESSION, handler: projectRoute },
  { method: 'GET', pattern: '/api/memory/:id', auth: SESSION, handler: memoryRoute },
  { method: 'GET', path: '/api/search', auth: SESSION, handler: searchRoute },
  { method: 'GET', path: '/api/cards', auth: SESSION, handler: cardsRoute },
  { method: 'GET', pattern: '/api/cards/:id', auth: SESSION, handler: cardRoute },
  { method: 'POST', pattern: '/api/memory/:id/pin', auth: SESSION, handler: pinRoute },
  { method: 'POST', pattern: '/api/memory/:id/wrong', auth: SESSION, handler: wrongRoute },
  { method: 'POST', pattern: '/api/memory/:id/forget', auth: SESSION, handler: forgetRoute },
  { method: 'POST', pattern: '/api/conflicts/:id/resolve', auth: SESSION, handler: resolveRoute },
  { method: 'GET', regex: PAGE, auth: SESSION, handler: pageRoute },
  { method: 'HEAD', regex: PAGE, auth: SESSION, handler: pageRoute },
];

/** What every dashboard request shares, built once at start. */
export interface DashboardServing {
  readonly access: DashboardAccess;
  readonly reader: DashboardReader;
  /** A fresh Context per request, so a config edit shows on the next one, on the request's deadline and signal. */
  readonly context: (limits: RequestLimits) => DashboardContext;
  readonly bodyDeadlineMs: number;
  readonly staticFiles: StaticFiles | null;
}

/** One dashboard request as the listener hands it over. */
export interface DashboardExchange {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly limits: RequestLimits;
}

/** A request before the gate. */
interface DashboardCall extends DashboardExchange {
  readonly query: URLSearchParams;
  readonly serving: DashboardServing;
}

function passGate({ req, res, query, serving }: DashboardCall): DashboardSession {
  return passDashboardSession(req, res, query, serving.access);
}

function admitted(call: DashboardCall, session: DashboardSession): DashboardRouteRequest {
  const { req, res, query, serving, limits } = call;
  const { reader, bodyDeadlineMs, staticFiles } = serving;
  return { req, res, query, session, ctx: serving.context(limits), reader, bodyDeadlineMs, staticFiles };
}

/** The row's run, gate first, or null when method or path differ; the path matcher runs first, as for a /v1 row. */
function dashboardRouteMatches(
  route: DashboardRoute,
  method: string,
  path: string,
): ((call: DashboardCall) => Promise<void>) | null {
  const run = bindPath<DashboardRouteRequest>(route, path);
  if (run === null || method !== route.method) return null;
  return async (call) => run(admitted(call, passGate(call)));
}

const findDashboardRoute = routeLookup(DASHBOARD_ROUTES, dashboardRouteMatches);

/** One dashboard request: the security headers, then the first matching row; a path no row takes still passes the gate
 * before its 404, so only a signed-in browser learns which paths exist. */
export async function answerDashboard(serving: DashboardServing, exchange: DashboardExchange): Promise<void> {
  const { req, res } = exchange;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const { method, path, query } = parseRequest(req);
  const call: DashboardCall = { ...exchange, query, serving };
  const match = findDashboardRoute(method, path);
  if (match === null) {
    passGate(call);
    sendError(res, 404, 'Not found');
    return;
  }
  noteAccess(req, { route: routeLabel(match.route) });
  await match.run(call);
}
