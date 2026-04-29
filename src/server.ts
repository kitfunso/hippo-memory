import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { writePidfile, removePidfile } from './server-detect.js';
import { resolveTenantId } from './tenant.js';
import { openHippoDb, closeHippoDb } from './db.js';
import { validateApiKey } from './auth.js';
import {
  remember,
  recall,
  forget,
  promote,
  supersede,
  archiveRaw,
  authCreate,
  authList,
  authRevoke,
  auditList,
  type Context,
} from './api.js';
import type { MemoryKind } from './memory.js';
import type { AuditOp } from './audit.js';
import { handleMcpRequest, type McpRequest } from './mcp/server.js';

const VALID_AUDIT_OPS: ReadonlySet<AuditOp> = new Set([
  'remember',
  'recall',
  'promote',
  'supersede',
  'forget',
  'archive_raw',
  'auth_revoke',
]);

// Cap on GET /v1/audit?limit=. Matches docs/api.md (when written) and is large
// enough to dump a small deployment's full audit log without paginating, but
// small enough that a malicious client can't ask for the world.
const MAX_AUDIT_LIMIT = 10000;

const VALID_KINDS: ReadonlySet<MemoryKind> = new Set([
  'raw',
  'distilled',
  'superseded',
  'archived',
]);

// Pinned at module load. Bumped alongside package.json on releases. The
// HTTP /health response uses this; reading package.json synchronously here
// would couple the daemon to its on-disk install path, which we want to
// avoid for tests that mkdtemp a hippoRoot.
const VERSION = '0.36.0';

// 1 MB body cap. The CLI never sends payloads near this; anything bigger is
// almost certainly a misconfigured client or a deliberate memory-blowup attempt.
const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export interface ServeOpts {
  hippoRoot: string;
  port?: number;
  host?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class BodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * Read the entire request body into a Buffer. Caps at MAX_BODY_BYTES to keep
 * a malicious or buggy client from exhausting memory. The cap is enforced
 * mid-stream so we don't wait for an attacker to finish before erroring out.
 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new BodyTooLargeError('request body exceeds 1MB');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'invalid JSON body');
  }
}

/**
 * Map an error thrown by an api.* function into an HTTP status + message.
 * api.* uses plain Error, so we discriminate by message pattern. Stable
 * patterns we rely on:
 *   - /not found/i  → 404 (forget on unknown id, supersede on unknown old id, etc.)
 *   - /unknown/i    → 404 (auth_revoke on unknown key_id)
 *   - /already superseded/i → 409 (chain conflict)
 *   - /not raw/i    → 400 (archive_raw on non-raw row)
 * Everything else maps to 400 (bad input).
 */
function mapApiError(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (/not found/.test(lower) || /^unknown /.test(lower)) {
    return { status: 404, message };
  }
  if (/already superseded/.test(lower)) {
    return { status: 409, message };
  }
  return { status: 400, message };
}

interface ParsedRoute {
  method: string;
  path: string;
  query: URLSearchParams;
}

function parseRequest(req: IncomingMessage): ParsedRoute {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
  };
}

/**
 * Lightweight pattern matcher for /v1/memories/:id/<action>. Avoids pulling
 * in a router dependency for the half-dozen patterns we actually use.
 *
 * Returns null if `path` does not match `pattern`. Otherwise returns an object
 * mapping each :param name to its value. Path segments are exact-matched
 * except for parameter slots.
 */
function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    const ap = pathParts[i]!;
    if (pp.startsWith(':')) {
      if (ap.length === 0) return null;
      params[pp.slice(1)] = decodeURIComponent(ap);
    } else if (pp !== ap) {
      return null;
    }
  }
  return params;
}

/**
 * Recognise loopback remote addresses. Node reports IPv6-mapped IPv4 as
 * '::ffff:127.0.0.1' on dual-stack sockets, so we accept that alongside
 * the bare v4 and v6 loopbacks. Anything else is treated as remote.
 */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  if (remoteAddress === '127.0.0.1') return true;
  if (remoteAddress === '::1') return true;
  if (remoteAddress === '::ffff:127.0.0.1') return true;
  return false;
}

/**
 * Read the Authorization header in a case-insensitive way and pull the
 * bearer token out. Returns:
 *   - { kind: 'absent' } when no Authorization header is present
 *   - { kind: 'malformed' } when the header is set but not 'Bearer <token>'
 *   - { kind: 'bearer', token } when a non-empty bearer token is present
 *
 * The header NAME is case-insensitive (Node lowercases all header names on
 * IncomingMessage.headers); the SCHEME ('Bearer') is also matched
 * case-insensitively per RFC 6750.
 */
type AuthHeader =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'bearer'; token: string };

function readAuthHeader(req: IncomingMessage): AuthHeader {
  const raw = req.headers['authorization'];
  if (raw === undefined) return { kind: 'absent' };
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) return { kind: 'malformed' };
  const space = value.indexOf(' ');
  if (space < 0) return { kind: 'malformed' };
  const scheme = value.slice(0, space);
  const token = value.slice(space + 1).trim();
  if (scheme.toLowerCase() !== 'bearer') return { kind: 'malformed' };
  if (token.length === 0) return { kind: 'malformed' };
  return { kind: 'bearer', token };
}

/**
 * Build a per-request Context from the Authorization header and remote
 * address. Throws HttpError(401) for invalid / missing credentials. Opens
 * the DB only when a Bearer token is present so loopback no-auth requests
 * stay cheap.
 */
function buildContextWithAuth(req: IncomingMessage, hippoRoot: string): Context {
  const auth = readAuthHeader(req);

  if (auth.kind === 'malformed') {
    throw new HttpError(401, 'invalid api key');
  }

  if (auth.kind === 'bearer') {
    const db = openHippoDb(hippoRoot);
    try {
      const result = validateApiKey(db, auth.token);
      if (!result.valid || !result.tenantId || !result.keyId) {
        throw new HttpError(401, 'invalid api key');
      }
      return {
        hippoRoot,
        tenantId: result.tenantId,
        actor: `api_key:${result.keyId}`,
      };
    } finally {
      closeHippoDb(db);
    }
  }

  // No Authorization header. Loopback-only fallback.
  if (!isLoopback(req.socket.remoteAddress)) {
    throw new HttpError(401, 'auth required');
  }

  return {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: 'localhost:cli',
  };
}

/**
 * Auth check for routes that do not need a tenant Context (e.g. MCP transport,
 * which builds its own root resolution via findHippoRoot). Throws HttpError
 * 401 the same way buildContextWithAuth does, but skips building the Context
 * envelope. Loopback no-auth still passes.
 */
function requireAuth(req: IncomingMessage, hippoRoot: string): void {
  const auth = readAuthHeader(req);
  if (auth.kind === 'malformed') {
    throw new HttpError(401, 'invalid api key');
  }
  if (auth.kind === 'bearer') {
    const db = openHippoDb(hippoRoot);
    try {
      const result = validateApiKey(db, auth.token);
      if (!result.valid) {
        throw new HttpError(401, 'invalid api key');
      }
    } finally {
      closeHippoDb(db);
    }
    return;
  }
  if (!isLoopback(req.socket.remoteAddress)) {
    throw new HttpError(401, 'auth required');
  }
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function getStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  if (!v.every((x) => typeof x === 'string')) return undefined;
  return v as string[];
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServeOpts,
  startedAt: string,
): Promise<void> {
  const { method, path, query } = parseRequest(req);

  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      started_at: startedAt,
      pid: process.pid,
    });
    return;
  }

  // POST /v1/memories
  if (method === 'POST' && path === '/v1/memories') {
    const body = await parseJsonBody(req);
    const content = getString(body, 'content');
    if (!content) {
      throw new HttpError(400, 'content is required');
    }
    const kindRaw = getString(body, 'kind');
    if (kindRaw !== undefined && !VALID_KINDS.has(kindRaw as MemoryKind)) {
      throw new HttpError(400, `invalid kind: ${kindRaw}`);
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = remember(ctx, {
      content,
      kind: kindRaw as MemoryKind | undefined,
      scope: getString(body, 'scope'),
      owner: getString(body, 'owner'),
      artifactRef: getString(body, 'artifactRef'),
      tags: getStringArray(body, 'tags'),
    });
    sendJson(res, 200, result);
    return;
  }

  // GET /v1/memories?q=...&limit=...&mode=...
  if (method === 'GET' && path === '/v1/memories') {
    const q = query.get('q');
    if (!q) {
      throw new HttpError(400, 'q is required');
    }
    const limitRaw = query.get('limit');
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      throw new HttpError(400, 'limit must be a positive number');
    }
    const mode = query.get('mode');
    if (mode !== null && mode !== 'bm25' && mode !== 'hybrid' && mode !== 'physics') {
      throw new HttpError(400, "mode must be 'bm25', 'hybrid', or 'physics'");
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = recall(ctx, {
      query: q,
      limit,
      mode: (mode ?? undefined) as 'bm25' | 'hybrid' | 'physics' | undefined,
    });
    sendJson(res, 200, result);
    return;
  }

  // /v1/memories/:id/* and DELETE /v1/memories/:id
  const archiveMatch = matchPath('/v1/memories/:id/archive', path);
  if (method === 'POST' && archiveMatch) {
    const body = await parseJsonBody(req);
    const reason = getString(body, 'reason');
    if (!reason) {
      throw new HttpError(400, 'reason is required');
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = archiveRaw(ctx, archiveMatch.id!, reason);
    sendJson(res, 200, result);
    return;
  }

  const supersedeMatch = matchPath('/v1/memories/:id/supersede', path);
  if (method === 'POST' && supersedeMatch) {
    const body = await parseJsonBody(req);
    const content = getString(body, 'content');
    if (!content) {
      throw new HttpError(400, 'content is required');
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = supersede(ctx, supersedeMatch.id!, content);
    sendJson(res, 200, result);
    return;
  }

  const promoteMatch = matchPath('/v1/memories/:id/promote', path);
  if (method === 'POST' && promoteMatch) {
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = promote(ctx, promoteMatch.id!);
    sendJson(res, 200, result);
    return;
  }

  const idMatch = matchPath('/v1/memories/:id', path);
  if (method === 'DELETE' && idMatch) {
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = forget(ctx, idMatch.id!);
    sendJson(res, 200, result);
    return;
  }

  // POST /v1/auth/keys — mint a new API key. Plaintext lands in the response
  // body (Task 8): the HTTP layer hands it to the client; the user-facing
  // "store this somewhere safe" warning belongs in the CLI client, not here.
  if (method === 'POST' && path === '/v1/auth/keys') {
    const body = await parseJsonBody(req);
    const labelRaw = body['label'];
    if (labelRaw !== undefined && typeof labelRaw !== 'string') {
      throw new HttpError(400, 'label must be a string');
    }
    const tenantIdRaw = body['tenantId'];
    if (tenantIdRaw !== undefined && typeof tenantIdRaw !== 'string') {
      throw new HttpError(400, 'tenantId must be a string');
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = authCreate(ctx, {
      label: labelRaw,
      tenantId: tenantIdRaw,
    });
    sendJson(res, 200, result);
    return;
  }

  // GET /v1/auth/keys?active=true — list keys visible to ctx.tenantId.
  // `active` defaults to true so the common case (show me usable keys) is
  // a single GET; ?active=false includes revoked rows.
  if (method === 'GET' && path === '/v1/auth/keys') {
    const activeRaw = query.get('active');
    let active = true;
    if (activeRaw !== null) {
      if (activeRaw === 'true') active = true;
      else if (activeRaw === 'false') active = false;
      else throw new HttpError(400, "active must be 'true' or 'false'");
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = authList(ctx, { active });
    sendJson(res, 200, result);
    return;
  }

  // DELETE /v1/auth/keys/:keyId — revoke. authRevoke throws "Unknown key_id"
  // for missing OR cross-tenant keys (no info leak), which mapApiError
  // converts to 404. We return 200 with the result body rather than 204 to
  // surface revokedAt to the caller.
  const keyMatch = matchPath('/v1/auth/keys/:keyId', path);
  if (method === 'DELETE' && keyMatch) {
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = authRevoke(ctx, keyMatch.keyId!);
    sendJson(res, 200, result);
    return;
  }

  // GET /v1/audit?op=&since=&limit= — read audit events. All three filters
  // validated at the route boundary so an invalid value lands a 400 before
  // we hit the DB.
  if (method === 'GET' && path === '/v1/audit') {
    const opRaw = query.get('op');
    let op: AuditOp | undefined;
    if (opRaw !== null) {
      if (!VALID_AUDIT_OPS.has(opRaw as AuditOp)) {
        throw new HttpError(400, `invalid op: ${opRaw}`);
      }
      op = opRaw as AuditOp;
    }
    const sinceRaw = query.get('since');
    let since: string | undefined;
    if (sinceRaw !== null) {
      const parsed = Date.parse(sinceRaw);
      if (!Number.isFinite(parsed)) {
        throw new HttpError(400, `invalid since: ${sinceRaw}`);
      }
      since = sinceRaw;
    }
    const limitRaw = query.get('limit');
    let limit: number | undefined;
    if (limitRaw !== null) {
      const parsed = Number(limitRaw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_AUDIT_LIMIT) {
        throw new HttpError(400, `limit must be an integer between 1 and ${MAX_AUDIT_LIMIT}`);
      }
      limit = parsed;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = auditList(ctx, { op, since, limit });
    sendJson(res, 200, result);
    return;
  }

  // ── MCP-over-HTTP/SSE transport (Task 11) ──
  //
  // Two routes implement an MCP HTTP transport alongside the stdio one. Both
  // dispatch to the same `handleMcpRequest` as the stdio loop in src/mcp/server.ts.
  //
  // POST /mcp        — Send a JSON-RPC request, get a JSON-RPC response synchronously
  //                    in the body. Content-type: application/json both ways.
  // GET  /mcp/stream — Open an SSE stream for server-initiated messages.
  //                    v1 simplification: this stream is keepalive-only. Clients
  //                    that need server-pushed notifications/progress will see
  //                    only `: ping` comments every 30s. All real responses come
  //                    back synchronously on POST /mcp. This matches the
  //                    "synchronous JSON in body" leg of the MCP HTTP spec and
  //                    is enough for `tools/list` / `tools/call` round-trips.
  //                    Server-initiated SSE messages will be wired in a later task.
  //
  // Auth: same as /v1/* — Bearer token validated via `requireAuth`, with the
  // loopback no-auth fallback. SSE check runs once at stream-open.

  if (method === 'POST' && path === '/mcp') {
    requireAuth(req, opts.hippoRoot);
    const raw = await readBody(req);
    let mcpReq: McpRequest;
    try {
      mcpReq = JSON.parse(raw) as McpRequest;
    } catch {
      throw new HttpError(400, 'invalid JSON-RPC body');
    }
    if (!mcpReq || typeof mcpReq !== 'object' || typeof mcpReq.method !== 'string') {
      throw new HttpError(400, 'JSON-RPC body must include a method string');
    }
    let mcpRes;
    try {
      mcpRes = await handleMcpRequest(mcpReq);
    } catch (err) {
      mcpRes = {
        jsonrpc: '2.0' as const,
        id: mcpReq.id,
        error: { code: -32603, message: err instanceof Error ? err.message : 'internal error' },
      };
    }
    if (mcpRes === null) {
      // Notification — no body, 202 Accepted.
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, mcpRes);
    return;
  }

  if (method === 'GET' && path === '/mcp/stream') {
    requireAuth(req, opts.hippoRoot);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // Initial ping so smoke tests can confirm the stream is live without
    // waiting 30s for the first keepalive interval.
    res.write(': ping\n\n');
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, 30000);
    // Don't keep the event loop alive just for this timer — the server's
    // listener already does that, and tests want the process to exit cleanly.
    if (typeof ping.unref === 'function') ping.unref();
    req.on('close', () => clearInterval(ping));
    return;
  }

  res.writeHead(404, JSON_HEADERS);
  res.end(JSON.stringify({ error: 'not found' }));
}

/**
 * Boot the HTTP daemon on host:port and write the pidfile under hippoRoot.
 *
 * Refuses non-loopback hosts at boot (Footgun #3 from the A1 plan): without
 * the A5 v2 auth middleware we have no way to gate remote requests, so we
 * fail fast rather than expose the DB to the network. Task 9 will lift this
 * restriction once Bearer-token validation lands.
 *
 * Use port: 0 in tests to bind to an ephemeral port and read the actual
 * port back via server.address() after listen.
 */
export async function serve(opts: ServeOpts): Promise<ServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const requestedPort = opts.port ?? Number(process.env.HIPPO_PORT ?? 6789);

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to bind hippo serve to non-loopback host '${host}' without auth. ` +
      `Remote-host serving requires the A5 v2 auth middleware (Task 9 of the A1 plan). ` +
      `Bind to 127.0.0.1 / ::1 / localhost, or wait for auth support.`,
    );
  }

  const startedAt = new Date().toISOString();

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, opts, startedAt).catch((err: unknown) => {
      if (res.headersSent) {
        try { res.end(); } catch { /* socket already gone */ }
        return;
      }
      if (err instanceof BodyTooLargeError) {
        sendError(res, 413, err.message);
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, err.status, err.message);
        return;
      }
      const mapped = mapApiError(err);
      sendError(res, mapped.status, mapped.message);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server.address() returned unexpected shape');
  }
  const actualPort = address.port;
  const url = `http://${host}:${actualPort}`;

  writePidfile(opts.hippoRoot, { port: actualPort, url });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    removePidfile(opts.hippoRoot);
    // Force-close any long-lived idle connections (e.g. SSE keepalive streams
    // on /mcp/stream) so server.close() can resolve. Without this, SIGTERM
    // would hang the process until the SSE client cancels. Available on
    // Node 18.2+; gate via optional chaining to avoid crashing on older runtimes.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  // Skip signal handlers under vitest so each test run does not register a
  // stray SIGTERM/SIGINT listener that survives until the runner exits.
  if (!process.env.VITEST) {
    process.once('SIGTERM', () => { void stop(); });
    process.once('SIGINT', () => { void stop(); });
  }

  return { port: actualPort, url, stop };
}
