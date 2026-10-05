// MCP over HTTP: POST /mcp and the GET /mcp/stream SSE keepalive.
import { envMcpSseHeartbeatMs, envMcpSseMaxAgeSec, envMcpSseMaxStreams } from '../env.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { handleMcpRequest, mcpErrorResponse, type McpRequest } from '../mcp/server.js';
import { HttpError, isJsonObjectRecord, readBody, sendJson } from '../http-util.js';
import { buildContextWithAuth, heartbeatVerdict, readAuthHeader, requireAuth } from './auth.js';
import { clientIpForRateLimit } from './client-ip.js';
import { requestIds } from './request.js';
import type { ResolvedServeOpts } from './types.js';
import { type JsonValue, isJsonString } from '../json.js';

/**
 * Build a per-client key for MCP state isolation under HTTP-MCP. Used by
 * mcp/server.ts to scope `lastRecalledIds` to the calling client so two
 * clients on the same tenant cannot poison each other's outcome feedback.
 *
 * Token is hashed (sha256, 16-hex-char prefix) so we never log or persist
 * the raw bearer. Combined with remoteAddress so two clients sharing a key
 * (e.g. on a shared Postman environment) are still separable in the common
 * case. 'noauth' covers loopback no-auth and is acceptable because that
 * path is single-host single-user.
 */
function buildMcpClientKey(req: IncomingMessage): string {
  const auth = readAuthHeader(req);
  const tokenHash = auth.kind === 'bearer'
    ? createHash('sha256').update(auth.token).digest('hex').slice(0, 16)
    : 'noauth';
  const addr = req.socket.remoteAddress ?? 'unknown';
  return `http:${tokenHash}:${addr}`;
}

// ── MCP-over-HTTP/SSE transport ──
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

export async function handleMcpPost(req: IncomingMessage, res: ServerResponse, opts: ResolvedServeOpts): Promise<void> {
  // Build the same Context the /v1/* routes use so MCP tool calls inherit
  // the server's bound hippoRoot and the auth-resolved tenantId / actor.
  // Without this, executeTool would walk from cwd via findHippoRoot() and
  // pull tenant from HIPPO_TENANT, dropping a valid Bearer for tenant B
  // back to whatever the env says.
  const ctx = await buildContextWithAuth(req, opts);
  const raw = await readBody(req);
  let mcpReq: JsonValue;
  try {
    mcpReq = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON-RPC body');
  }
  if (!isJsonObjectRecord(mcpReq) || !isJsonString(mcpReq.method)) {
    throw new HttpError(400, 'JSON-RPC body must include a method string');
  }
  // SAFETY: validated above as a plain JSON object carrying a string method;
  // the remaining McpRequest wire fields (jsonrpc, id, params) are checked or
  // safely defaulted inside handleMcpRequest's JSON-RPC dispatch.
  const rpcReq = mcpReq as McpRequest & Record<string, JsonValue>;
  let mcpRes;
  try {
    mcpRes = await handleMcpRequest(rpcReq, {
      hippoRoot: ctx.hippoRoot,
      tenantId: ctx.tenantId,
      // McpContext.actor stays string; extract subject at the boundary.
      actor: ctx.actor.subject,
      // The caller's real role: MCP tools must not run a member key as admin.
      role: ctx.actor.role,
      scopes: ctx.actor.scopes,
      viaAuthResolver: ctx.actor.viaAuthResolver,
      hostAdmin: ctx.actor.hostAdmin,
      clientKey: buildMcpClientKey(req),
      store: ctx.store,
    });
  } catch (err) {
    mcpRes = mcpErrorResponse(rpcReq.id, err, requestIds.get(req));
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
  if (auth.kind === 'bearer') return `key:${createHash('sha256').update(auth.token).digest('hex').slice(0, 16)}`;
  return `ip:${clientIpForRateLimit(req)}`;
}

/** Takes a stream slot or throws 429; the slot is released once, when the response closes. */
function acquireStreamSlot(req: IncomingMessage, res: ServerResponse, slots: Map<string, number>): void {
  const max = envMcpSseMaxStreams() ?? DEFAULT_MAX_STREAMS_PER_CLIENT;
  const key = streamSlotKey(req);
  const open = slots.get(key) ?? 0;
  if (open >= max) throw new HttpError(429, `too many open streams for this client (limit ${max}); close one first`);
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

  // SSE hardening:
  //   - Heartbeat re-validates the bearer (default 60s). If the key was
  //     revoked or rotated, close the stream with reason='auth_revoked'.
  //   - MCP_SSE_MAX_AGE_SEC (default 3600) caps stream lifetime; close
  //     with reason='max_age_exceeded' when reached.
  //   - MCP_SSE_HEARTBEAT_MS (default 60000) lets tests run with a short
  //     interval without waiting a full minute.
  const heartbeatMs =
    envMcpSseHeartbeatMs() ?? 60000;
  const maxAgeMs =
    (envMcpSseMaxAgeSec() ?? 3600) * 1000;
  const startedAt = Date.now();
  let closed = false;
  let checking = false;
  const closeWith = (reason: string): void => {
    if (closed) return;
    closed = true;
    try {
      res.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
    } catch { /* socket already gone */ }
    try { res.end(); } catch { /* socket already gone */ }
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
