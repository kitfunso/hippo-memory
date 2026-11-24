import {
  envBodyTimeoutMs,
  envMcpSseHeartbeatMs,
  envMcpSseMaxAgeSec,
  envMcpSseMaxStreams,
} from '../../base/util/env.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '../../api/index.js';
import { sharedStoreOf } from '../../api/types.js';
import {
  handleMcpRequest,
  mcpErrorResponse,
  type McpContext,
  type McpRequest,
} from '../mcp/server.js';
import { HttpError } from '../../base/errors/http-errors.js';
import { bodyDeadlineMs, readBody, sendJson } from '../http/http-util.js';
import { errorFields, log } from '../../base/util/log.js';
import { callName } from '../mcp/protocol.js';
import { assertCallerProject } from '../../base/scope/project-identity.js';
import type { CallerProject } from '../../api/prompt-hook.js';
import { buildContextWithAuth, heartbeatVerdict, readAuthHeader, requireAuth } from './auth.js';
import { clientLimitKey } from './client-ip.js';
import { withOAuthChallenge } from './oauth-resource.js';
import { endReply, noteAccess, writeChunk } from './request.js';
import type { ResolvedServeOptions } from './types.js';
import { type JsonValue, isJsonString, isJsonObject, tryParseJson } from '../../base/util/json.js';
import { tryDecodeUri } from '../../base/util/expected-errors.js';
import { blockHash } from '../../base/util/token-text.js';
import { MINUTE_MS } from '../../base/util/time.js';

const DEFAULT_SSE_HEARTBEAT_MS = MINUTE_MS;
const DEFAULT_SSE_MAX_AGE_SEC = 3600;

// Percent-encoded by the client, so any lowercase Unicode name fits a Latin-1 header.
const HEADER_PIECE = /^[A-Za-z0-9\-_.!~*'()%]+$/;

function decodeHeaderPiece(raw: string, header: string): string {
  if (!HEADER_PIECE.test(raw)) {
    throw new HttpError(400, `${header} must be percent-encoded, with no empty names`);
  }
  const decoded = tryDecodeUri(raw);
  if (decoded === undefined) throw new HttpError(400, `${header} holds a bad percent escape`);
  return decoded;
}

/** On a shared store, the caller's project from X-Hippo-Project and the comma-separated
 * X-Hippo-Project-Aliases; any other store ignores both. */
export function callerProjectFromHeaders(
  req: IncomingMessage,
  shared: boolean,
): CallerProject | undefined {
  if (!shared) return undefined;
  const names = req.headersDistinct['x-hippo-project'];
  const aliasHeaders = req.headersDistinct['x-hippo-project-aliases'];
  if (names === undefined) {
    if (aliasHeaders !== undefined) {
      throw new HttpError(400, 'X-Hippo-Project-Aliases needs X-Hippo-Project');
    }
    return undefined;
  }
  if (names.length > 1 || (aliasHeaders?.length ?? 0) > 1) {
    throw new HttpError(400, 'send X-Hippo-Project and X-Hippo-Project-Aliases once each');
  }
  const name = decodeHeaderPiece(names[0]!, 'X-Hippo-Project');
  const rawAliases = aliasHeaders?.[0] ?? '';
  const aliases =
    rawAliases === ''
      ? []
      : rawAliases.split(',').map((a) => decodeHeaderPiece(a, 'X-Hippo-Project-Aliases'));
  assertCallerProject({ name, aliases });
  return { name, legacyName: name, aliases };
}

function mcpContextFor(
  ctx: Context,
  opts: ResolvedServeOptions,
  project?: CallerProject,
): McpContext {
  const mcpCtx: McpContext = {
    hippoRoot: opts.hippoRoot,
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    role: ctx.actor.role,
    scopes: ctx.actor.scopes,
    viaAuthResolver: ctx.actor.viaAuthResolver,
    hostAdmin: ctx.actor.hostAdmin,
    owner: ctx.actor.owner,
    clientKey: ctx.clientKey,
    store: ctx.store,
    storeFor: opts.storeFor,
    tools: opts.mcpTools,
    config: ctx.config,
    reach: ctx.reach,
    callers: ctx.callers,
    infra: ctx.infra,
    detached: ctx.detached,
    projectWriteGate: ctx.projectWriteGate,
    projectWriteGateTimeoutMs: ctx.projectWriteGateTimeoutMs,
  };
  if (project !== undefined) mcpCtx.project = project;
  return mcpCtx;
}

export async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ResolvedServeOptions,
): Promise<void> {
  const ctx = await withOAuthChallenge(req, res, opts.oauthChallenge, () =>
    buildContextWithAuth(req, opts),
  );
  noteAccess(req, { tenant: ctx.tenantId });
  const project = callerProjectFromHeaders(req, sharedStoreOf(ctx));
  const raw = await readBody(req, { deadlineMs: bodyDeadlineMs(envBodyTimeoutMs()) });
  const mcpReq = tryParseJson(raw);
  if (mcpReq === undefined) throw new HttpError(400, 'invalid JSON-RPC body');
  if (!isJsonObject(mcpReq) || !isJsonString(mcpReq.method)) {
    throw new HttpError(400, 'JSON-RPC body must include a method string');
  }
  // SAFETY: validated above as a plain JSON object with a string method; the other McpRequest wire
  // fields (jsonrpc, id, params) are checked or defaulted in handleMcpRequest.
  const rpcReq = mcpReq as McpRequest & Record<string, JsonValue>;
  let mcpRes;
  try {
    mcpRes = await handleMcpRequest(rpcReq, mcpContextFor(ctx, opts, project));
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

const DEFAULT_MAX_STREAMS_PER_CLIENT = 8;

function streamSlotKey(req: IncomingMessage): string {
  const auth = readAuthHeader(req);
  if (auth.kind === 'bearer') return `key:${blockHash(auth.token)}`;
  return `ip:${clientLimitKey(req)}`;
}

function acquireStreamSlot(
  req: IncomingMessage,
  res: ServerResponse,
  slots: Map<string, number>,
): void {
  const max = envMcpSseMaxStreams() ?? DEFAULT_MAX_STREAMS_PER_CLIENT;
  const key = streamSlotKey(req);
  const open = slots.get(key) ?? 0;
  if (open >= max) {
    throw new HttpError(
      429,
      `too many open streams for this client (limit ${max}); close one first`,
      60,
    );
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
  if (req.destroyed || res.destroyed || req.socket.destroyed) return;
  acquireStreamSlot(req, res, streamSlots);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': ping\n\n');

  keepStreamAlive(req, res, opts);
}

function keepStreamAlive(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ResolvedServeOptions,
): void {
  const heartbeatMs = envMcpSseHeartbeatMs() ?? DEFAULT_SSE_HEARTBEAT_MS;
  const maxAgeMs = (envMcpSseMaxAgeSec() ?? DEFAULT_SSE_MAX_AGE_SEC) * 1000;
  const startedAt = Date.now();
  const beat = newStreamBeat(res, () => clearInterval(ping));
  const ping = setInterval(() => {
    if (beat.closed) {
      clearInterval(ping);
      return;
    }
    if (Date.now() - startedAt >= maxAgeMs) {
      beat.closeWith('max_age_exceeded');
      clearInterval(ping);
      return;
    }
    if (beat.checking) return;
    beat.checking = true;
    checkHeartbeat(req, res, opts, beat);
  }, heartbeatMs);
  if (ping.unref instanceof Function) ping.unref();
  // res 'close' covers an early socket drop that req 'close' can miss.
  res.on('close', () => {
    beat.closed = true;
    clearInterval(ping);
  });
}

interface StreamBeat {
  closed: boolean;
  checking: boolean;
  readonly closeWith: (reason: string) => void;
  readonly stop: () => void;
}

function newStreamBeat(res: ServerResponse, stop: () => void): StreamBeat {
  const beat: StreamBeat = {
    closed: false,
    checking: false,
    closeWith: (reason) => {
      if (beat.closed) return;
      beat.closed = true;
      endStreamWithReason(res, reason);
    },
    stop,
  };
  return beat;
}

function checkHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ResolvedServeOptions,
  beat: StreamBeat,
): void {
  heartbeatVerdict(req, opts)
    .then((verdict) => {
      beat.checking = false;
      if (!beat.closed && verdict === 'unavailable') {
        log.warn('heartbeat tick skipped: auth check unavailable');
      }
      if (beat.closed || verdict === 'unavailable') return;
      if (verdict === 'revoked') {
        beat.closeWith('auth_revoked');
        beat.stop();
        return;
      }
      if (!writePing(res)) beat.stop();
    })
    .catch((err) => {
      beat.checking = false;
      log.warn('heartbeat tick failed', errorFields(err));
    });
}

function writePing(res: ServerResponse): boolean {
  return writeChunk(res, ': ping\n\n');
}

function endStreamWithReason(res: ServerResponse, reason: string): void {
  if (writeChunk(res, `event: closed\ndata: ${JSON.stringify({ reason })}\n\n`)) endReply(res);
  else res.destroy();
}
