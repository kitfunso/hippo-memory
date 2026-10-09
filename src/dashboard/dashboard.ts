/** Hippo dashboard server: the React bundle plus the JSON API behind the Health view and the Board (`hippo dashboard --port`). */

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import type { AddressInfo } from 'net';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { evalNow } from '../core/ablation.js';
import { readEntry } from '../store/entry-reads.js';
import { listCards } from '../store/cards.js';
import { resolveTenantId } from '../store/tenant.js';
import { loadCardDetail } from '../store/card-detail.js';
import { bodyDeadlineMs, BodyTimeoutError, closeAfterReply, isCrossSite, LOOPBACK_HOST_HEADER } from '../util/http-util.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { createSnapshotService, isLiveMemory, type SnapshotService } from './dashboard-snapshot.js';
import {
  buildMemoryDetail, buildMemoryPage, buildOverview, buildProjectDetail, buildSearch,
} from './dashboard-queries.js';
import {
  forgetMemory, markWrong, pinMemory, resolveOpenConflict, type ActionResult,
} from './dashboard-actions.js';
import {
  ParamError, parseActionBody, parseConflictId, parseMemoryId, parseMemoryQuery, parseSearchText, type ActionBody,
} from './dashboard-params.js';
import { runWithRequestId } from '../util/request-scope.js';
import { installSignalHandlers } from '../util/crash-handlers.js';
import { DEFAULT_SHUTDOWN_DRAIN_MS, drainAndClose, setKeepAliveTimeouts, shutdownBoundMs } from '../server/lifecycle.js';
import { printError } from '../cli/output.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
} as const;

const BODY_MAX_BYTES = 4096;
const BODY_DRAIN_MAX_BYTES = 64 * 1024;
const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;
const CARD_ID = /^[A-Za-z0-9_-]+$/;

type StaticFileExtension = keyof typeof MIME_TYPES;

function isStaticFileExtension(ext: string): ext is StaticFileExtension {
  return Object.hasOwn(MIME_TYPES, ext);
}

function jsonResponse<T>(res: http.ServerResponse, data: T, status: number = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(body);
}

function forbidden(res: http.ServerResponse): void {
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end('Forbidden');
}

function notFoundJson(res: http.ServerResponse): void {
  jsonResponse(res, { error: 'Not found' }, 404);
}

function serveStaticFile(res: http.ServerResponse, filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!isStaticFileExtension(ext)) return false;
  const mime = MIME_TYPES[ext];

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
    });
    res.end(content);
    return true;
  } catch {
    return false; // an unreadable asset falls through to the next route, which answers 404 or the fallback page
  }
}

/** Raised once a body passes the drain ceiling; the caller answers 400 and drops the socket. */
class BodyDrainExceeded extends ParamError {}

// Past the cap it keeps draining so the socket stays usable, up to a ceiling, then refuses.
function readActionBody(req: http.IncomingMessage): Promise<ActionBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    const deadlineMs = bodyDeadlineMs();
    const timer = setTimeout(() => reject(new BodyTimeoutError(`request body not received within ${deadlineMs} ms`)), deadlineMs);
    // Unref: a request that already failed another way must not hold the process open for the rest of the deadline.
    timer.unref();
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_MAX_BYTES) chunks.push(chunk);
      if (size > BODY_DRAIN_MAX_BYTES && !aborted) {
        aborted = true;
        reject(new BodyDrainExceeded(`Body must be at most ${BODY_DRAIN_MAX_BYTES} bytes`));
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      clearTimeout(timer);
      if (size > BODY_MAX_BYTES) return reject(new ParamError(`Body must be at most ${BODY_MAX_BYTES} bytes`));
      try {
        resolve(parseActionBody(Buffer.concat(chunks).toString('utf8').trim()));
      } catch (err) {
        reject(err);
      }
    });
  });
}

interface RouteContext {
  hippoRoot: string;
  snapshots: SnapshotService;
  now: () => number;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
}

function sendOrNotFound<T extends object>(res: http.ServerResponse, body: T | null): true {
  if (body === null) notFoundJson(res);
  else jsonResponse(res, body);
  return true;
}

function handleRead(ctx: RouteContext, segments: string[]): boolean {
  const { hippoRoot, snapshots, req, res, url } = ctx;
  const tenantId = resolveTenantId({});
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
    const entry = readEntry(hippoRoot, parseMemoryId(a), tenantId);
    if (entry === null || !isLiveMemory(entry)) return sendOrNotFound(res, null);
    const snapshotId = snapshots.get(tenantId, fresh).id;
    const embedded = snapshots.embeddedIds()?.has(entry.id) ?? false;
    return sendOrNotFound(res, buildMemoryDetail(hippoRoot, tenantId, entry, { snapshotId, nowMs: ctx.now(), embedded }));
  }
  if (head === 'search' && segments.length === 2) {
    return sendOrNotFound(res, buildSearch(snapshots.get(tenantId, fresh), parseSearchText(url.searchParams)));
  }
  if (head === 'cards' && segments.length === 2) {
    return sendOrNotFound(res, { cards: listCards(hippoRoot, tenantId) });
  }
  if (head === 'cards' && a !== undefined && segments.length === 3) {
    // The Board has always answered 404, not 400, for an id that does not fit the pattern.
    return sendOrNotFound(res, CARD_ID.test(a) ? loadCardDetail(hippoRoot, tenantId, a) ?? null : null);
  }
  return false;
}

// Names the action only; nothing runs until the cross-site, content-type and body guards pass.
function matchAction(segments: string[]): ((hippoRoot: string, tenantId: string, body: ActionBody) => ActionResult) | null {
  const [, head, id, verb] = segments;
  if (segments.length !== 4 || id === undefined) return null;
  if (head === 'memory' && verb === 'pin') return (root, tenant, body) => pinMemory(root, tenant, id, body);
  if (head === 'memory' && verb === 'wrong') return (root, tenant) => markWrong(root, tenant, id);
  if (head === 'memory' && verb === 'forget') return (root, tenant) => forgetMemory(root, tenant, id);
  if (head === 'conflicts' && verb === 'resolve') {
    return (root, tenant, body) => resolveOpenConflict(root, tenant, parseConflictId(id), body);
  }
  return null;
}

async function handlePost(ctx: RouteContext, segments: string[]): Promise<boolean> {
  const action = matchAction(segments);
  if (action === null) return false;
  const { req, res, hippoRoot, snapshots } = ctx;
  if (isCrossSite(req)) {
    forbidden(res);
    return true;
  }
  if (!JSON_CONTENT_TYPE.test(req.headers['content-type'] ?? '')) {
    jsonResponse(res, { error: 'Content-Type must be application/json' }, 415);
    req.resume();
    return true;
  }
  const body = await readActionBody(req);
  const tenantId = resolveTenantId({});
  const result = action(hippoRoot, tenantId, body);
  if (result.changed) snapshots.invalidate();
  if (result.entry) {
    // The write is committed, so a rebuild failure must not turn it into a 500: the next read rebuilds.
    const embedded = snapshots.embeddedIds()?.has(result.entry.id) ?? false;
    const detail = buildMemoryDetail(hippoRoot, tenantId, result.entry, { snapshotId: snapshots.currentId(), nowMs: ctx.now(), embedded });
    jsonResponse(res, detail, result.status);
  } else {
    jsonResponse(res, result.body, result.status);
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

function sameToken(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
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
  res.end(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Hippo Dashboard</title></head><body></body></html>`);
  return true;
}

/** True when the request may proceed; false when this already answered it (redirect off the token URL, or 401). */
function admitDashboardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  access: { token: string; port: number },
): boolean {
  const { token, port } = access;
  // Cookies ignore the port, so the name carries it: two dashboards on one host keep separate tokens.
  const cookieName = `hippo_dashboard_${req.socket.localPort ?? port}`;
  if (sameToken(url.searchParams.get('token') ?? undefined, token)) {
    res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
    if (leaveTokenUrl(req, res, url)) return false;
  } else if (!sameToken(cookieValue(req.headers.cookie, cookieName), token)) {
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
    log.error('dashboard request failed', { ...errorFields(err), error: errorMessage(err), path: req.url });
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
  if (err instanceof ParamError) return jsonResponse(res, { error: err.message }, 400);
  if (err instanceof URIError) return jsonResponse(res, { error: 'Malformed URL path' }, 400);
  jsonResponse(res, { error: 'Internal error' }, 500);
}

function printDashboardBanner(boundPort: number, token: string, distUiDir: string | null): void {
  // The banner is the `hippo dashboard` command's printed result, so it stays on stdout.
  console.log(`Hippo Dashboard running at http://localhost:${boundPort}/?token=${token}`);
  if (distUiDir !== null) console.log(`Serving React UI from ${distUiDir}`);
  console.log('Press Ctrl+C to stop.');
}

/** A port that will not open is the user's to fix, so it gets one plain line and a failure exit code, not an uncaught error's stack. */
function reportListenFailure(port: number, err: Error): void {
  const inUse = 'code' in err && err.code === 'EADDRINUSE';
  printError(inUse
    ? `hippo dashboard: port ${port} is already in use. Stop the program that holds it, or choose another port with --port <number>.`
    : `hippo dashboard: could not listen on port ${port}: ${err.message}. Choose another port with --port <number>.`);
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

/** Gives the listener the API server's socket deadlines and one close of the store's connection; with `handleSignals`, a signal stops it too. */
function superviseListener(server: http.Server, snapshots: SnapshotService, port: number, handleSignals: boolean): void {
  setKeepAliveTimeouts(server);
  let storeClosed = false;
  const closeStore = (): void => {
    if (storeClosed) return;
    storeClosed = true;
    snapshots.close();
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
/** Serves the dashboard on 127.0.0.1 behind a per-start `token` (tests pass one), since loopback alone lets any local process read every memory; `opts` sets the projection and cache clocks. */
export function serveDashboard(
  hippoRoot: string,
  port: number = 3333,
  token: string = randomBytes(32).toString('base64url'),
  opts?: { now?: () => number; cacheClock?: () => number; handleSignals?: boolean },
): http.Server {
  const distUiDir = path.resolve(import.meta.dirname, '..', 'dist-ui');
  const hasDistUi = fs.existsSync(path.join(distUiDir, 'index.html'));
  const now = opts?.now ?? ((): number => evalNow().getTime());
  const snapshots = createSnapshotService(hippoRoot, now, opts?.cacheClock);

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const host = req.headers.host;
    if (host !== undefined && !LOOPBACK_HOST_HEADER.test(host)) return forbidden(res);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (!admitDashboardRequest(req, res, url, { token, port })) return;

    if (url.pathname.startsWith('/api/')) {
      // A malformed % sequence throws URIError here; the caller answers 400.
      const segments = url.pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
      const ctx: RouteContext = { hippoRoot, snapshots, now, req, res, url };
      const handled = req.method === 'GET' ? handleRead(ctx, segments)
        : req.method === 'POST' ? await handlePost(ctx, segments)
        : false;
      if (!handled) notFoundJson(res);
      return;
    }

    if (hasDistUi) return serveSpa(res, distUiDir, url.pathname);
    notBuilt(res);
  };

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    handleRequest(req, res).catch((err) => answerDashboardFailure(req, res, err));
  };
  // One id per request, so the lines it logs can be told apart from a concurrent request's.
  const server = http.createServer((req, res) => runWithRequestId(randomUUID(), () => onRequest(req, res)));
  superviseListener(server, snapshots, port, opts?.handleSignals === true);

  server.listen(port, '127.0.0.1', () => {
    // SAFETY: listen() was given a TCP port, so address() is AddressInfo, never a pipe name.
    const boundPort = (server.address() as AddressInfo).port;
    printDashboardBanner(boundPort, token, hasDistUi ? distUiDir : null);
  });

  return server;
}
