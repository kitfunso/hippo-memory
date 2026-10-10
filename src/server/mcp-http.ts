// MCP over HTTP: POST /mcp and the GET /mcp/stream SSE keepalive.
import { envMcpSseHeartbeatMs, envMcpSseMaxAgeSec, envMcpSseMaxStreams } from '../util/env.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '../api/index.js';
import { isSharedStore } from '../core/config.js';
import { handleMcpRequest, mcpErrorResponse, type McpContext, type McpRequest } from '../mcp/server.js';
import { HttpError, readBody, sendJson } from '../util/http-util.js';
import { assertCallerProject } from '../core/project-identity.js';
import type { CallerProject } from '../api/prompt-hook.js';
import { buildContextWithAuth, heartbeatVerdict, readAuthHeader, requireAuth } from './auth.js';
import { clientLimitKey, subscriberKey } from './client-ip.js';
import { noteAccess } from './request.js';
import type { ResolvedServeOpts } from './types.js';
import { type JsonValue, isJsonString, isJsonObject } from '../util/json.js';
import { blockHash } from '../util/token-text.js';

const DEFAULT_SSE_HEARTBEAT_MS = 60000;
const DEFAULT_SSE_MAX_AGE_SEC = 3600;

/** Per-client key for MCP state isolation under HTTP-MCP (scopes `lastRecalledIds`): sha256 of the token (16 hex chars, so the raw bearer is never logged)
 * plus remoteAddress, so clients sharing a key stay separable; 'noauth' covers loopback no-auth, which is single-host single-user. */
function buildMcpClientKey(req: IncomingMessage): string {
  const auth = readAuthHeader(req);
  const tokenHash = auth.kind === 'bearer'
    ? blockHash(auth.token)
    : 'noauth';
  const addr = subscriberKey(req.socket.remoteAddress ?? 'unknown');
  return `http:${tokenHash}:${addr}`;
}

// MCP-over-HTTP/SSE: POST /mcp answers a JSON-RPC request synchronously; GET /mcp/stream is a keepalive-only SSE stream (`: ping` every 30s) in v1.
// Both dispatch to handleMcpRequest as stdio does. Auth matches /v1/* (Bearer via `requireAuth`, loopback fallback); SSE is checked once at stream-open.

// Percent-encoded by the client, so any lowercase Unicode name fits a Latin-1 header.
const HEADER_PIECE = /^[A-Za-z0-9\-_.!~*'()%]+$/;

function decodeHeaderPiece(raw: string, header: string): string {
  if (!HEADER_PIECE.test(raw)) throw new HttpError(400, `${header} must be percent-encoded, with no empty names`);
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, `${header} holds a bad percent escape`);
  }
}

/** On a shared store, the caller's project from X-Hippo-Project and the comma-separated X-Hippo-Project-Aliases; any other store ignores both. */
export function callerProjectFromHeaders(req: IncomingMessage, hippoRoot: string): CallerProject | undefined {
  if (!isSharedStore(hippoRoot)) return undefined;
  const names = req.headersDistinct['x-hippo-project'];
  const aliasHeaders = req.headersDistinct['x-hippo-project-aliases'];
  if (names === undefined) {
    if (aliasHeaders !== undefined) throw new HttpError(400, 'X-Hippo-Project-Aliases needs X-Hippo-Project');
    return undefined;
  }
  if (names.length > 1 || (aliasHeaders?.length ?? 0) > 1) throw new HttpError(400, 'send X-Hippo-Project and X-Hippo-Project-Aliases once each');
  const name = decodeHeaderPiece(names[0]!, 'X-Hippo-Project');
  const rawAliases = aliasHeaders?.[0] ?? '';
  const aliases = rawAliases === '' ? [] : rawAliases.split(',').map((a) => decodeHeaderPiece(a, 'X-Hippo-Project-Aliases'));
  assertCallerProject({ name, aliases });
  return { name, legacyName: name, aliases };
}

function mcpContextFor(ctx: Context, clientKey: string, autoSleep: McpContext['autoSleep'], project?: CallerProject): McpContext {
  const mcpCtx: McpContext = {
    hippoRoot: ctx.hippoRoot,
    tenantId: ctx.tenantId,
    // McpContext.actor stays string; extract subject at the boundary.
    actor: ctx.actor.subject,
    // The caller's real role: MCP tools must not run a member key as admin.
    role: ctx.actor.role,
    scopes: ctx.actor.scopes,
    viaAuthResolver: ctx.actor.viaAuthResolver,
    hostAdmin: ctx.actor.hostAdmin,
    owner: ctx.actor.owner,
    clientKey,
    store: ctx.store,
    autoSleep,
  };
  if (project !== undefined) mcpCtx.project = project;
  return mcpCtx;
}

export async function handleMcpPost(req: IncomingMessage, res: ServerResponse, opts: ResolvedServeOpts): Promise<void> {
  // Same Context the /v1/* routes use, so MCP tool calls inherit the bound hippoRoot and the auth-resolved tenantId/actor; otherwise executeTool would walk
  // from cwd and read HIPPO_TENANT, dropping a valid Bearer for tenant B to the env's tenant.
  const ctx = await buildContextWithAuth(req, opts);
  noteAccess(req, { tenant: ctx.tenantId });
  const project = callerProjectFromHeaders(req, ctx.hippoRoot);
  const raw = await readBody(req);
  let mcpReq: JsonValue;
  try {
    mcpReq = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON-RPC body');
  }
  if (!isJsonObject(mcpReq) || !isJsonString(mcpReq.method)) {
    throw new HttpError(400, 'JSON-RPC body must include a method string');
  }
  // SAFETY: validated above as a plain JSON object with a string method; the other McpRequest wire fields (jsonrpc, id, params) are checked or defaulted in
  // handleMcpRequest.
  const rpcReq = mcpReq as McpRequest & Record<string, JsonValue>;
  let mcpRes;
  try {
    mcpRes = await handleMcpRequest(rpcReq, mcpContextFor(ctx, buildMcpClientKey(req), opts.autoSleep, project));
  } catch (err) {
    mcpRes = mcpErrorResponse(rpcReq.id, err);
  }
  if (mcpRes === null) {
    // Notification — no body, 202 Accepted.
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, mcpRes);
}

// Each open stream holds a socket and a timer, so one key (or one IP when keyless) gets a bounded number.
const DEFAULT_MAX_STREAMS_PER_CLIENT = 8;

/** The bucket a stream counts against: a hash of the bearer token, else the client IP. */
function streamSlotKey(req: IncomingMessage): string {
  const auth = readAuthHeader(req);
  if (auth.kind === 'bearer') return `key:${blockHash(auth.token)}`;
  return `ip:${clientLimitKey(req)}`;
}

/** Takes a stream slot or throws 429; the slot is released once, when the response closes. */
function acquireStreamSlot(req: IncomingMessage, res: ServerResponse, slots: Map<string, number>): void {
  const max = envMcpSseMaxStreams() ?? DEFAULT_MAX_STREAMS_PER_CLIENT;
  const key = streamSlotKey(req);
  const open = slots.get(key) ?? 0;
  if (open >= max) throw new HttpError(429, `too many open streams for this client (limit ${max}); close one first`, 60);
  slots.set(key, open + 1);
  res.once('close', () => {
    const left = (slots.get(key) ?? 1) - 1;
    if (left > 0) slots.set(key, left);
    else slots.delete(key);
  });
}

export async function handleMcpStream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ResolvedServeOpts,
  streamSlots: Map<string, number>,
): Promise<void> {
  await requireAuth(req, opts);
  // An async resolver can outlive the client; 'close' has already fired, so no timer may start.
  if (req.destroyed || res.destroyed || req.socket.destroyed) return;
  acquireStreamSlot(req, res, streamSlots);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // Initial ping so smoke tests can confirm the stream is live without
  // waiting for the first keepalive interval.
  res.write(': ping\n\n');

  // SSE hardening: the heartbeat re-validates the bearer (MCP_SSE_HEARTBEAT_MS, default 60000) and closes with 'auth_revoked' if the key was revoked or
  // rotated; MCP_SSE_MAX_AGE_SEC (default 3600) caps stream lifetime and closes with 'max_age_exceeded'.
  keepStreamAlive(req, res, opts);
}

function keepStreamAlive(req: IncomingMessage, res: ServerResponse, opts: ResolvedServeOpts): void {
  const heartbeatMs =
    envMcpSseHeartbeatMs() ?? DEFAULT_SSE_HEARTBEAT_MS;
  const maxAgeMs =
    (envMcpSseMaxAgeSec() ?? DEFAULT_SSE_MAX_AGE_SEC) * 1000;
  const startedAt = Date.now();
  let closed = false;
  let checking = false;
  const closeWith = (reason: string): void => {
    if (closed) return;
    closed = true;
    endStreamWithReason(res, reason);
  };
  const ping = setInterval(() => {
    if (closed) {
      clearInterval(ping);
      return;
    }
    if (Date.now() - startedAt >= maxAgeMs) {
      closeWith('max_age_exceeded');
      clearInterval(ping);
      return;
    }
    if (checking) return;
    checking = true;
    void heartbeatVerdict(req, opts).then((verdict) => {
      checking = false;
      if (closed || verdict === 'unavailable') return;
      if (verdict === 'revoked') {
        closeWith('auth_revoked');
        clearInterval(ping);
        return;
      }
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping); // the client hung up; stop pinging a dead socket
      }
    });
  }, heartbeatMs);
  // Don't keep the event loop alive just for this timer — the server's
  // listener already does that, and tests want the process to exit cleanly.
  if (ping.unref instanceof Function) ping.unref();
  // res 'close' covers an early socket drop that req 'close' can miss.
  res.on('close', () => {
    closed = true;
    clearInterval(ping);
  });
}

function endStreamWithReason(res: ServerResponse, reason: string): void {
  try {
    res.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
  } catch { /* socket already gone */ }
  try { res.end(); } catch { /* socket already gone */ }
}
