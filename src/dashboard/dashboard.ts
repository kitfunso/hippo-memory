/** Hippo dashboard server: the React bundle plus the JSON API behind the Health view and the Board (`hippo dashboard --port`). */

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import type { AddressInfo } from 'net';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { adminActor, type Context } from '../api/index.js';
import { memoryGet } from '../api/memories/memories.js';
import { cardDetail, cardList } from '../api/objects/cards.js';
import { cliConfig, cliStore } from '../cli/api-context.js';
import { evalNow } from '../core/ablation.js';
import type { HippoStore, StoreGroups } from '../store/port.js';
import { envTenant } from '../util/env.js';
import {
  BodyTimeoutError,
  BodyTooLargeError,
  bodyDeadlineMs,
  closeAfterReply,
  isCrossSite,
  LOOPBACK_HOST_HEADER,
  readBody,
  sendJson,
} from '../util/http-util.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { createSnapshotService, isLiveMemory, type SnapshotService } from './dashboard-snapshot.js';
import { serveStaticFile } from './static-file.js';
import {
  buildMemoryDetail,
  buildMemoryPage,
  buildOverview,
  buildProjectDetail,
  buildSearch,
} from './dashboard-queries.js';
import { forgetMemory, markWrong, pinMemory, resolveOpenConflict, type ActionResult } from './dashboard-actions.js';
import {
  ParamError,
  parseActionBody,
  parseConflictId,
  parseMemoryId,
  parseMemoryQuery,
  parseSearchText,
  type ActionBody,
} from './dashboard-params.js';
import type { MemoryDetail } from './dashboard-types.js';
import { runWithRequestId } from '../util/request-scope.js';
import { installSignalHandlers } from '../util/crash-handlers.js';
import {
  DEFAULT_SHUTDOWN_DRAIN_MS,
  drainAndClose,
  setKeepAliveTimeouts,
  shutdownBoundMs,
} from '../server/lifecycle.js';
import { printError } from '../cli/output.js';
import { PACKAGE_ROOT } from '../core/package-root.js';
import { DAY_MS } from '../util/time.js';

// The audit log's actor for every dashboard write.
const DASHBOARD_ACTOR = 'dashboard';
const BODY_MAX_BYTES = 4096;
const BODY_DRAIN_MAX_BYTES = 64 * 1024;
const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;
const CARD_ID = /^[A-Za-z0-9_-]+$/;

function forbidden(res: http.ServerResponse): void {
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end('Forbidden');
}

function notFoundJson(res: http.ServerResponse): void {
  sendJson(res, 404, { error: 'Not found' });
}

/** Raised once a body passes the drain ceiling; the caller answers 400 and drops the socket. */
class BodyDrainExceeded extends ParamError {}

// Past the cap it keeps draining so the socket stays usable, up to a ceiling, then refuses.
async function readActionBody(req: http.IncomingMessage, deadlineMs: number): Promise<ActionBody> {
  let text: string;
  try {
    text = await readBody(req, { maxBytes: BODY_DRAIN_MAX_BYTES, deadlineMs });
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      throw new BodyDrainExceeded(`Body must be at most ${BODY_DRAIN_MAX_BYTES} bytes`);
    }
    throw err;
  }
  if (Buffer.byteLength(text) > BODY_MAX_BYTES) throw new ParamError(`Body must be at most ${BODY_MAX_BYTES} bytes`);
  return parseActionBody(text.trim());
}

/** What every request shares; built once in openDashboardRoot. */
interface DashboardRoot {
  readonly store: HippoStore & StoreGroups;
  /** A fresh api Context on the server's one store, so a config edit shows on the next request. */
  readonly context: () => Context;
  readonly snapshots: SnapshotService;
  readonly now: () => number;
  readonly bodyDeadlineMs: number;
  /** Closes the snapshot cache and the store. */
  readonly release: () => void;
}

interface RouteContext extends DashboardRoot {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
}

function sendOrNotFound<T extends object>(res: http.ServerResponse, body: T | null): true {
  if (body === null) notFoundJson(res);
  else sendJson(res, 200, body);
  return true;
}

/** The drawer's detail of a live memory, or null when the tenant holds no live row with that id. */
async function memoryDetail(ctx: RouteContext, id: string, fresh: boolean): Promise<MemoryDetail | null> {
  const context = ctx.context();
  const entry = await memoryGet(context, id);
  if (entry === null || !isLiveMemory(entry)) return null;
  const snapshotId = ctx.snapshots.get(context.tenantId, fresh).id;
  const embedded = ctx.snapshots.isEmbedded(entry.id);
  return buildMemoryDetail(ctx.store, context.tenantId, entry, { snapshotId, nowMs: ctx.now(), embedded });
}

async function handleRead(ctx: RouteContext, segments: string[]): Promise<boolean> {
  const { snapshots, req, res, url } = ctx;
  const tenantId = envTenant();
  // A cross-site <img src=...?fresh=1> must not force a full rebuild.
  const fresh = url.searchParams.get('fresh') === '1' && !isCrossSite(req);
  const [, head, a, b] = segments;

  if (head === 'overview' && segments.length === 2) {
    return sendOrNotFound(res, buildOverview(snapshots.get(tenantId, fresh)));
  }
  if (head === 'projects' && a !== undefined && segments.length === 4 && b === 'memories') {
    const query = parseMemoryQuery(url.searchParams);
    return sendOrNotFound(res, buildMemoryPage(snapshots.get(tenantId, fresh), a, query));
  }
  if (head === 'projects' && a !== undefined && segments.length === 3) {
    return sendOrNotFound(res, buildProjectDetail(snapshots.get(tenantId, fresh), a));
  }
  if (head === 'memory' && a !== undefined && segments.length === 3) {
    return sendOrNotFound(res, await memoryDetail(ctx, parseMemoryId(a), fresh));
  }
  if (head === 'search' && segments.length === 2) {
    return sendOrNotFound(res, buildSearch(snapshots.get(tenantId, fresh), parseSearchText(url.searchParams)));
  }
  if (head === 'cards' && segments.length === 2) {
    return sendOrNotFound(res, { cards: await cardList(ctx.context()) });
  }
  if (head === 'cards' && a !== undefined && segments.length === 3) {
    // The Board has always answered 404, not 400, for an id that does not fit the pattern.
    return sendOrNotFound(res, CARD_ID.test(a) ? await cardDetail(ctx.context(), a) : null);
  }
  return false;
}

// Names the action only; nothing runs until the cross-site, content-type and body guards pass.
function matchAction(segments: string[]): ((ctx: Context, body: ActionBody) => Promise<ActionResult>) | null {
  const [, head, id, verb] = segments;
  if (segments.length !== 4 || id === undefined) return null;
  if (head === 'memory' && verb === 'pin') return (ctx, body) => pinMemory(ctx, id, body);
  if (head === 'memory' && verb === 'wrong') return (ctx) => markWrong(ctx, id);
  if (head === 'memory' && verb === 'forget') return (ctx) => forgetMemory(ctx, id);
  if (head === 'conflicts' && verb === 'resolve') {
    return (ctx, body) => resolveOpenConflict(ctx, parseConflictId(id), body);
  }
  return null;
}

async function handlePost(ctx: RouteContext, segments: string[]): Promise<boolean> {
  const action = matchAction(segments);
  if (action === null) return false;
  const { req, res, store, snapshots } = ctx;
  if (isCrossSite(req)) {
    forbidden(res);
    return true;
  }
  if (!JSON_CONTENT_TYPE.test(req.headers['content-type'] ?? '')) {
    sendJson(res, 415, { error: 'Content-Type must be application/json' });
    req.resume();
    return true;
  }
  const body = await readActionBody(req, ctx.bodyDeadlineMs);
  const context = ctx.context();
  const { tenantId } = context;
  const result = await action(context, body);
  if (result.changed) snapshots.invalidate();
  if (result.entry) {
    // The write is committed, so a rebuild failure must not turn it into a 500: the next read rebuilds.
    const embedded = snapshots.isEmbedded(result.entry.id);
    const options = { snapshotId: snapshots.currentId(), nowMs: ctx.now(), embedded };
    const detail = await buildMemoryDetail(store, tenantId, result.entry, options);
    sendJson(res, result.status, detail);
  } else {
    sendJson(res, result.status, result.body);
  }
  return true;
}

// One style block, not style attributes, so the policy below can name its hash and allow no other inline style.
const NOT_BUILT_CSS =
  "body{font-family:Georgia,'Palatino Linotype',serif;max-width:640px;margin:60px auto;padding:24px;line-height:1.6;background:#f4efe6;color:#3a3228}" +
  'h1{color:#c45c3c}' +
  'pre{background:#faf7f2;padding:16px;border:1px solid #c4b9a8;border-radius:3px;font-family:Consolas,monospace}';

// Memory text is written by other tools and people, so every reply tells the browser to load code only from this server and never to frame, sniff or name the page elsewhere.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'sha256-${createHash('sha256').update(NOT_BUILT_CSS).digest('base64')}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
} as const;

function notBuilt(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="en"><head><title>Hippo Dashboard</title><meta charset="utf-8"><style>${NOT_BUILT_CSS}</style></head>
<body>
<h1>Hippo Dashboard</h1>
<p>The React UI bundle is not built yet. Run:</p>
<pre>cd ui && npm install && npm run build</pre>
<p>Then refresh this page. The dashboard server will serve <code>dist-ui/index.html</code> automatically once present.</p>
</body></html>`);
}

function serveSpa(res: http.ServerResponse, distUiDir: string, pathname: string): void {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(distUiDir, safePath);
  // The separator matters: a bare prefix also admits a sibling folder whose name starts with this one.
  if (filePath !== distUiDir && !filePath.startsWith(distUiDir + path.sep)) return forbidden(res);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile() && serveStaticFile(res, filePath)) return;
  // SPA fallback: non-file routes get index.html.
  if (serveStaticFile(res, path.join(distUiDir, 'index.html'))) return;
  notBuilt(res);
}

function sameSecret(given: string | undefined, secret: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Where a page load that carried the token goes next, without it; null for an API call or a write, which is answered in place. */
function tokenFreeLocation(req: http.IncomingMessage, url: URL): string | null {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || url.pathname.startsWith('/api/')) return null;
  const query = new URLSearchParams(url.searchParams);
  query.delete('token');
  const rest = query.toString();
  // One leading slash only: `//host` would send the browser to another site.
  return `${url.pathname.replace(/^\/+/, '/')}${rest ? `?${rest}` : ''}`;
}

/** Moves the browser off the URL that carries the token, so the token stays out of history, bookmarks and copied links; false when the request is answered in place. */
function leaveTokenUrl(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  const location = tokenFreeLocation(req, url);
  if (location === null) return false;
  if (req.headers['sec-fetch-site'] !== 'cross-site') {
    res.writeHead(303, { Location: location });
    res.end();
    return true;
  }
  // A browser withholds a SameSite=Strict cookie from a redirect another site started; a refresh from this page is same-site.
  const target = location.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Hippo Dashboard</title></head><body></body></html>`,
  );
  return true;
}

// A browser that restores its session keeps a cookie with no Max-Age for good; no Secure, since this server speaks plain HTTP on loopback only.
const DASHBOARD_COOKIE_MAX_AGE_S = DAY_MS / 1000;

/** The session cookie's value: a MAC of the token, so a read of the browser's cookie store never yields the token. */
function sessionValue(token: string, port: number): string {
  return createHmac('sha256', token).update(`hippo-dashboard-session:${port}`).digest('hex');
}

/** True when the request may proceed; false when this already answered it (redirect off the token URL, or 401). */
function admitDashboardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  access: { token: string; port: number },
): boolean {
  const { token } = access;
  const port = req.socket.localPort ?? access.port;
  // Cookies ignore the port, so the name carries it: two dashboards on one host keep separate sessions.
  const cookieName = `hippo_dashboard_${port}`;
  const session = sessionValue(token, port);
  if (sameSecret(url.searchParams.get('token') ?? undefined, token)) {
    res.setHeader(
      'Set-Cookie',
      `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DASHBOARD_COOKIE_MAX_AGE_S}`,
    );
    if (leaveTokenUrl(req, res, url)) return false;
  } else if (!sameSecret(cookieValue(req.headers.cookie, cookieName), session)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized: open the dashboard with the URL `hippo dashboard` printed; it carries the access token.');
    return false;
  }
  return true;
}

function answerDashboardFailure(req: http.IncomingMessage, res: http.ServerResponse, err: Error): void {
  const clientFault = err instanceof ParamError || err instanceof URIError || err instanceof BodyTimeoutError;
  // A cut-short response is logged even for a client fault; a bare 400 is not.
  if (res.headersSent || !clientFault) {
    log.error('dashboard request failed', {
      ...errorFields(err),
      error: errorMessage(err),
      path: (req.url ?? '/').split('?')[0],
    });
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof BodyDrainExceeded || err instanceof BodyTimeoutError) {
    // No `Connection: close` header: Node then destroys the socket as soon as the reply is written.
    res.writeHead(err instanceof BodyTimeoutError ? 408 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }), () => closeAfterReply(req));
    return;
  }
  if (err instanceof ParamError) return sendJson(res, 400, { error: err.message });
  if (err instanceof URIError) return sendJson(res, 400, { error: 'Malformed URL path' });
  sendJson(res, 500, { error: 'Internal error' });
}

const DASHBOARD_URL_FILE = 'dashboard.url';

function printDashboardBanner(hippoRoot: string, boundPort: number, token: string, distUiDir: string | null): void {
  // The banner is the `hippo dashboard` command's printed result, so it stays on stdout.
  const url = `http://localhost:${boundPort}/?token=${token}`;
  if (process.stdout.isTTY) {
    console.log(`Hippo Dashboard running at ${url}`);
  } else {
    // Captured stdout lands in logs, so the token goes to an owner-only file, created fresh so its mode holds.
    const file = path.join(hippoRoot, DASHBOARD_URL_FILE);
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, `${url}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`Hippo Dashboard running at http://localhost:${boundPort}/ (open the URL with its token from ${file})`);
  }
  if (distUiDir !== null) console.log(`Serving React UI from ${distUiDir}`);
  console.log('Press Ctrl+C to stop.');
}

/** A port that will not open is the user's to fix, so it gets one plain line and a failure exit code, not an uncaught error's stack. */
function reportListenFailure(port: number, err: Error): void {
  const inUse = 'code' in err && err.code === 'EADDRINUSE';
  printError(
    inUse
      ? `hippo dashboard: port ${port} is already in use. Stop the program that holds it, or choose another port with --port <number>.`
      : `hippo dashboard: could not listen on port ${port}: ${err.message}. Choose another port with --port <number>.`,
  );
  process.exitCode = 1;
}

/** Ctrl+C or a stop signal: stop listening, give open requests the API server's drain, and leave within its shutdown bound. */
function stopOnSignal(server: http.Server): void {
  const inflight = new Set<http.ServerResponse>();
  server.on('request', (_req, res) => {
    inflight.add(res);
    res.once('close', () => inflight.delete(res));
  });
  installSignalHandlers('dashboard', {
    run: () => drainAndClose(server, inflight, DEFAULT_SHUTDOWN_DRAIN_MS),
    boundMs: shutdownBoundMs(DEFAULT_SHUTDOWN_DRAIN_MS),
  });
}

/** Gives the listener the API server's socket deadlines and one `release` of the store; with `handleSignals`, a signal stops it too. */
function superviseListener(server: http.Server, release: () => void, port: number, handleSignals: boolean): void {
  setKeepAliveTimeouts(server);
  let storeClosed = false;
  const closeStore = (): void => {
    if (storeClosed) return;
    storeClosed = true;
    release();
  };
  server.on('close', closeStore);
  server.on('error', (err) => {
    // Once it listens, an 'error' is a failed accept: logged, as the API server does, and the dashboard keeps serving.
    if (server.listening) return log.error(`dashboard: listener error: ${err.message}`, errorFields(err));
    reportListenFailure(port, err);
    // A failed listen emits no 'close', so the store closes here.
    closeStore();
  });
  if (handleSignals) stopOnSignal(server);
}
interface DashboardOptions {
  readonly now?: () => number;
  readonly cacheClock?: () => number;
  readonly handleSignals?: boolean;
  /** The HIPPO_BODY_TIMEOUT_MS value the CLI read; 30 s when unset. */
  readonly bodyDeadlineMs?: number;
}

/** The composition root: one store, built as the CLI builds it, a Context per request with the actor every write
 * audits as, and the snapshot cache over the same store. */
function openDashboardRoot(hippoRoot: string, opts: DashboardOptions): DashboardRoot {
  const store = cliStore(hippoRoot);
  const now = opts.now ?? ((): number => evalNow().getTime());
  const snapshots = createSnapshotService(store.localFiles.dashboard, now, opts.cacheClock);
  return {
    store,
    now,
    snapshots,
    bodyDeadlineMs: bodyDeadlineMs(opts.bodyDeadlineMs),
    context: () => ({
      hippoRoot,
      tenantId: envTenant(),
      actor: adminActor(DASHBOARD_ACTOR),
      store,
      config: cliConfig(hippoRoot),
    }),
    release: () => {
      snapshots.close();
      store.close().catch((err) => {
        log.error(`dashboard: closing the store failed: ${errorMessage(err)}`, errorFields(err));
      });
    },
  };
}

function dashboardRequestHandler(
  root: ReturnType<typeof openDashboardRoot>,
  spa: { distUiDir: string; hasDistUi: boolean },
  auth: { token: string; port: number },
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const host = req.headers.host;
    if (host !== undefined && !LOOPBACK_HOST_HEADER.test(host)) return forbidden(res);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (!admitDashboardRequest(req, res, url, auth)) return;

    if (url.pathname.startsWith('/api/')) {
      // A malformed % sequence throws URIError here; the caller answers 400.
      const segments = url.pathname
        .split('/')
        .filter((s) => s !== '')
        .map((s) => decodeURIComponent(s));
      const ctx: RouteContext = { ...root, req, res, url };
      const handled =
        req.method === 'GET'
          ? await handleRead(ctx, segments)
          : req.method === 'POST'
            ? await handlePost(ctx, segments)
            : false;
      if (!handled) notFoundJson(res);
      return;
    }

    if (spa.hasDistUi) return serveSpa(res, spa.distUiDir, url.pathname);
    notBuilt(res);
  };
}

/** Serves the dashboard on 127.0.0.1 behind a per-start `token` (tests pass one), since loopback alone lets any local process read every memory; `opts` sets the projection and cache clocks. */
export function serveDashboard(
  hippoRoot: string,
  port: number = 3333,
  token: string = randomBytes(32).toString('base64url'),
  opts?: DashboardOptions,
): http.Server {
  const distUiDir = path.join(PACKAGE_ROOT, 'dist-ui');
  const hasDistUi = fs.existsSync(path.join(distUiDir, 'index.html'));
  const root = openDashboardRoot(hippoRoot, opts ?? {});

  const handleRequest = dashboardRequestHandler(root, { distUiDir, hasDistUi }, { token, port });

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    handleRequest(req, res).catch((err) => answerDashboardFailure(req, res, err));
  };
  // One id per request, so the lines it logs can be told apart from a concurrent request's.
  const server = http.createServer((req, res) => runWithRequestId(randomUUID(), () => onRequest(req, res)));
  superviseListener(server, root.release, port, opts?.handleSignals === true);

  server.listen(port, '127.0.0.1', () => {
    // SAFETY: listen() was given a TCP port, so address() is AddressInfo, never a pipe name.
    const boundPort = (server.address() as AddressInfo).port;
    printDashboardBanner(hippoRoot, boundPort, token, hasDistUi ? distUiDir : null);
  });

  return server;
}
