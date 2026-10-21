// MCP over HTTP: POST /mcp and the GET /mcp/stream SSE keepalive.
import {
  envBodyTimeoutMs,
  envMcpSseHeartbeatMs,
  envMcpSseMaxAgeSec,
  envMcpSseMaxStreams,
} from '../../base/util/env.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '../../api/index.js';
import { sharedStoreOf } from '../../api/types.js';
import { handleMcpRequest, mcpErrorResponse, type McpContext, type McpRequest } from '../mcp/server.js';
import { bodyDeadlineMs, HttpError, readBody, sendJson } from '../../base/util/http-util.js';
import { errorFields, log } from '../../base/util/log.js';
import { callName } from '../mcp/protocol.js';
import { assertCallerProject } from '../../base/scope/project-identity.js';
import type { CallerProject } from '../../api/prompt-hook.js';
import { buildContextWithAuth, heartbeatVerdict, readAuthHeader, requireAuth } from './auth.js';
import { clientLimitKey } from './client-ip.js';
import { clientKeyOf } from './client-key.js';
import { endReply, noteAccess, writeChunk } from './request.js';
import type { ResolvedServeOptions } from './types.js';
import { type JsonValue, isJsonString, isJsonObject, tryParseJson } from '../../base/util/json.js';
import { tryDecodeUri } from '../../base/util/expected-errors.js';
import { blockHash } from '../../base/util/token-text.js';
import { MINUTE_MS } from '../../base/util/time.js';

const DEFAULT_SSE_HEARTBEAT_MS = MINUTE_MS;
const DEFAULT_SSE_MAX_AGE_SEC = 3600;

// MCP-over-HTTP/SSE: POST /mcp answers a JSON-RPC request synchronously; GET /mcp/stream is a keepalive-only SSE stream
// (`: ping` every DEFAULT_SSE_HEARTBEAT_MS, 60 s) in v1. Both dispatch to handleMcpRequest as stdio does. Auth matches
// /v1/* (Bearer via `requireAuth`, loopback fallback); an SSE stream is checked at open and again before every ping.

// Percent-encoded by the client, so any lowercase Unicode name fits a Latin-1 header.
const HEADER_PIECE = /^[A-Za-z0-9\-_.!~*'()%]+$/;

function decodeHeaderPiece(raw: string, header: string): string {
  if (!HEADER_PIECE.test(raw)) throw new HttpError(400, `${header} must be percent-encoded, with no empty names`);
  const decoded = tryDecodeUri(raw);
  if (decoded === undefined) throw new HttpError(400, `${header} holds a bad percent escape`);
  return decoded;
}

/** On a shared store, the caller's project from X-Hippo-Project and the comma-separated X-Hippo-Project-Aliases; any
 * other store ignores both. */
export function callerProjectFromHeaders(req: IncomingMessage, shared: boolean): CallerProject | undefined {
  if (!shared) return undefined;
  const names = req.headersDistinct['x-hippo-project'];
  const aliasHeaders = req.headersDistinct['x-hippo-project-aliases'];
  if (names === undefined) {
    if (aliasHeaders !== undefined) throw new HttpError(400, 'X-Hippo-Project-Aliases needs X-Hippo-Project');
    return undefined;
  }
  if (names.length > 1 || (aliasHeaders?.length ?? 0) > 1) {
    throw new HttpError(400, 'send X-Hippo-Project and X-Hippo-Project-Aliases once each');
  }
  const name = decodeHeaderPiece(names[0]!, 'X-Hippo-Project');
  const rawAliases = aliasHeaders?.[0] ?? '';
  const aliases =
    rawAliases === '' ? [] : rawAliases.split(',').map((a) => decodeHeaderPiece(a, 'X-Hippo-Project-Aliases'));
  assertCallerProject({ name, aliases });
  return { name, legacyName: name, aliases };
}

function mcpContextFor(ctx: Context, hippoRoot: string, clientKey: string, project?: CallerProject): McpContext {
  const mcpCtx: McpContext = {
    hippoRoot,
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
    config: ctx.config,
    reach: ctx.reach,
    callers: ctx.callers,
  };
  if (project !== undefined) mcpCtx.project = project;
  return mcpCtx;
}

export async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ResolvedServeOptions,
): Promise<void> {
  // Same Context the /v1/* routes use, so tool calls inherit the bound hippoRoot and the auth-resolved tenantId/actor;
  // else executeTool walks from cwd and reads HIPPO_TENANT, dropping a valid Bearer for tenant B to the env's tenant.
  const ctx = await buildContextWithAuth(req, opts);
  noteAccess(req, { tenant: ctx.tenantId });
  const project = callerProjectFromHeaders(req, sharedStoreOf(ctx));
  const raw = await readBody(req, { deadlineMs: bodyDeadlineMs(envBodyTimeoutMs()) });
  const mcpReq = tryParseJson(raw);
  if (mcpReq === undefined) throw new HttpError(400, 'invalid JSON-RPC body');
  if (!isJsonObject(mcpReq) || !isJsonString(mcpReq.method)) {
    throw new HttpError(400, 'JSON-RPC body must include a method string');
  }
  // SAFETY: validated above as a plain JSON object with a string method; the other McpRequest wire fields (jsonrpc, id,
  // params) are checked or defaulted in handleMcpRequest.
  const rpcReq = mcpReq as McpRequest & Record<string, JsonValue>;
  let mcpRes;
  try {
    mcpRes = await handleMcpRequest(rpcReq, mcpContextFor(ctx, opts.hippoRoot, clientKeyOf(req), project));
  } catch (err) {
    mcpRes = mcpErrorResponse(rpcReq.id, err, undefined, callName(rpcReq));
  }
  if (mcpRes === null) {
    // Notification — no body, 202 Accepted.
    res.writeHead(202);
    endReply(res);
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
  if (open >= max) {
    throw new HttpError(429, `too many open streams for this client (limit ${max}); close one first`, 60);
  }
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
  opts: ResolvedServeOptions,
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
  // Initial ping so smoke tests can confirm the stream is live without waiting for the first keepalive interval.
  res.write(': ping\n\n');

  // SSE hardening: the heartbeat re-validates the bearer (MCP_SSE_HEARTBEAT_MS, default 60000) and closes with
  // 'auth_revoked' if the key was revoked or rotated; MCP_SSE_MAX_AGE_SEC (default 3600) ends it as 'max_age_exceeded'.
  keepStreamAlive(req, res, opts);
}

function keepStreamAlive(req: IncomingMessage, res: ServerResponse, opts: ResolvedServeOptions): void {
  const heartbeatMs = envMcpSseHeartbeatMs() ?? DEFAULT_SSE_HEARTBEAT_MS;
  const maxAgeMs = (envMcpSseMaxAgeSec() ?? DEFAULT_SSE_MAX_AGE_SEC) * 1000;
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
    heartbeatVerdict(req, opts)
      .then((verdict) => {
        checking = false;
        if (!closed && verdict === 'unavailable') log.warn('heartbeat tick skipped: auth check unavailable');
        if (closed || verdict === 'unavailable') return;
        if (verdict === 'revoked') {
          closeWith('auth_revoked');
          clearInterval(ping);
          return;
        }
        if (!writePing(res)) clearInterval(ping);
      })
      .catch((err) => {
        // Without the reset `checking` stays true and the heartbeat never runs again.
        checking = false;
        log.warn('heartbeat tick failed', errorFields(err));
      });
  }, heartbeatMs);
  // Don't keep the event loop alive just for this timer; the server's listener already does that, and tests want the
  // process to exit cleanly.
  if (ping.unref instanceof Function) ping.unref();
  // res 'close' covers an early socket drop that req 'close' can miss.
  res.on('close', () => {
    closed = true;
    clearInterval(ping);
  });
}

/** False when the client hung up, so the caller stops pinging a dead socket. */
function writePing(res: ServerResponse): boolean {
  return writeChunk(res, ': ping\n\n');
}

function endStreamWithReason(res: ServerResponse, reason: string): void {
  // A socket that refused the write is already logged; end() on it would only log the same failure again.
  if (writeChunk(res, `event: closed\ndata: ${JSON.stringify({ reason })}\n\n`)) endReply(res);
  else res.destroy();
}
