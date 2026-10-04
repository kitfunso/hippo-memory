/** Hippo dashboard server: the React bundle plus the JSON API behind the Health view and the Board (`hippo dashboard --port`). */

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { evalNow } from './ablation.js';
import { readEntry } from './store.js';
import { listCards } from './store-cards.js';
import { resolveTenantId } from './tenant.js';
import { loadCardDetail } from './card-detail.js';
import { isCrossSite, LOOPBACK_HOST_HEADER } from './http-util.js';
import { log } from './log.js';
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
    return sendOrNotFound(res, buildMemoryDetail(hippoRoot, tenantId, entry, snapshotId, ctx.now(), embedded));
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
    const detail = buildMemoryDetail(hippoRoot, tenantId, result.entry, snapshots.currentId(), ctx.now(), embedded);
    jsonResponse(res, detail, result.status);
  } else {
    jsonResponse(res, result.body, result.status);
  }
  return true;
}

function notBuilt(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="en"><head><title>Hippo Dashboard</title><meta charset="utf-8"></head>
<body style="font-family:Georgia,'Palatino Linotype',serif;max-width:640px;margin:60px auto;padding:24px;line-height:1.6;background:#f4efe6;color:#3a3228">
<h1 style="color:#c45c3c">Hippo Dashboard</h1>
<p>The React UI bundle is not built yet. Run:</p>
<pre style="background:#faf7f2;padding:16px;border:1px solid #c4b9a8;border-radius:3px;font-family:Consolas,monospace">cd ui && npm install && npm run build</pre>
<p>Then refresh this page. The dashboard server will serve <code>dist-ui/index.html</code> automatically once present.</p>
</body></html>`);
}

function serveSpa(res: http.ServerResponse, distUiDir: string, pathname: string): void {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(distUiDir, safePath);
  if (!filePath.startsWith(distUiDir)) return forbidden(res);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile() && serveStaticFile(res, filePath)) return;
  // SPA fallback: non-file routes get index.html.
  if (serveStaticFile(res, path.join(distUiDir, 'index.html'))) return;
  notBuilt(res);
}

/** Starts the dashboard on loopback; `opts.now` dates the projections (default: the eval clock) and `opts.cacheClock` ages the snapshot cache (default: the wall clock). */
export function serveDashboard(hippoRoot: string, port: number = 3333, opts?: { now?: () => number; cacheClock?: () => number }): http.Server {
  const distUiDir = path.resolve(import.meta.dirname, '..', 'dist-ui');
  const hasDistUi = fs.existsSync(path.join(distUiDir, 'index.html'));
  const now = opts?.now ?? ((): number => evalNow().getTime());
  const snapshots = createSnapshotService(hippoRoot, now, opts?.cacheClock);

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const host = req.headers.host;
    if (host !== undefined && !LOOPBACK_HOST_HEADER.test(host)) return forbidden(res);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

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

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      const clientFault = err instanceof ParamError || err instanceof URIError;
      // A cut-short response is logged even for a client fault; a bare 400 is not.
      if (res.headersSent || !clientFault) {
        log.error('dashboard request failed', { error: err instanceof Error ? err.message : String(err), path: req.url });
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof BodyDrainExceeded) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
        res.end(JSON.stringify({ error: err.message }), () => req.destroy());
        return;
      }
      if (err instanceof ParamError) return jsonResponse(res, { error: err.message }, 400);
      if (err instanceof URIError) return jsonResponse(res, { error: 'Malformed URL path' }, 400);
      jsonResponse(res, { error: 'Internal error' }, 500);
    });
  });
  server.on('close', () => snapshots.close());

  server.listen(port, '127.0.0.1', () => {
    // The banner is the `hippo dashboard` command's printed result, so it stays on stdout.
    console.log(`Hippo Dashboard running at http://localhost:${port}`);
    if (hasDistUi) console.log(`Serving React UI from ${distUiDir}`);
    console.log('Press Ctrl+C to stop.');
  });

  return server;
}
