// Stdio transport: newline-delimited JSON-RPC frames in on stdin, replies out on stdout.

import { exitAfterFlush, installCrashHandlers } from '../util/crash-handlers.js';
import { envRequestDeadlineMs, envTenant } from '../util/env.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { requestDeadlineMs } from '../util/request-scope.js';
import { MAX_BODY_BYTES } from '../util/http-util.js';
import { parseFrame, type FrameRemainder } from './framing.js';
import {
  callName,
  findHippoRoot,
  mcpErrorResponse,
  type McpHost,
  type McpRequest,
  type McpResponse,
} from './protocol.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import { handleMcpRequest } from './request.js';
import { errorReply, INVALID_REQUEST, PARSE_ERROR, REQUEST_TIMEOUT } from './json-rpc.js';
import { type JsonValue, isJsonNumber, isJsonString, isJsonObject } from '../util/json.js';
import { randomUUID } from 'node:crypto';
import { currentRequestId, runWithRequestId } from '../util/request-scope.js';

// MCP stdio transport spec: messages are newline-delimited JSON-RPC, no embedded
// newlines. https://modelcontextprotocol.io/specification/.../basic/transports#stdio
function send(msg: McpResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Stdio transport ──

let pending: Uint8Array[] = [];
let pendingBytes = 0;
// Set when the pending bytes hold a Content-Length header whose body has not fully arrived.
let needs: number | undefined;
// The part of a refused frame still on its way, dropped as it arrives so it is never buffered or read as a new frame.
let refused: FrameRemainder = 0;

function withoutRefused(chunk: Buffer): Buffer {
  if (refused === 'line') {
    const newline = chunk.indexOf(0x0a);
    if (newline === -1) return chunk.subarray(chunk.length);
    refused = 0;
    return chunk.subarray(newline + 1);
  }
  const dropped = Math.min(refused, chunk.length);
  refused -= dropped;
  return chunk.subarray(dropped);
}

// Only method is checked: handleMcpRequest narrows params where it reads them, as the HTTP transport does.
function isRoutableRequest(v: JsonValue): v is JsonValue & McpRequest {
  return isJsonObject(v) && isJsonString(v.method);
}

/** A frame that parsed but names no method: with an id it is a request owed an answer; without one it is a
 * notification, which JSON-RPC forbids answering. */
function answerUnroutable(frame: JsonValue): void {
  const id = isJsonObject(frame) ? frame.id : undefined;
  if (isJsonString(id) || isJsonNumber(id)) {
    send(errorReply(id, INVALID_REQUEST, 'Invalid Request: method must be a string'));
    return;
  }
  log.warn('mcp: dropped a frame with no method and no id; it cannot be routed or answered');
}

/** How long stdin's end waits for calls still running, so a client that closes right after its last request still
 * gets the reply. */
const STDIN_END_DRAIN_MS = 5000;
const CRASH_DRAIN_SLACK_MS = 1000;

// Calls dispatched and not yet answered, each with the method the drain names if it is still running at the bound.
const inFlight = new Map<Promise<void>, string>();

function track(method: string, call: Promise<void>): void {
  inFlight.set(call, method);
  call
    .finally(() => inFlight.delete(call))
    .catch((err) => log.error(`mcp: ${method} failed after it was dispatched`, errorFields(err)));
}

async function drainInFlight(): Promise<void> {
  if (inFlight.size > 0) {
    let bound: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      bound = setTimeout(resolve, STDIN_END_DRAIN_MS);
    });
    await Promise.race([Promise.allSettled(inFlight.keys()), timedOut]);
    clearTimeout(bound);
  }
  for (const method of inFlight.values()) {
    log.warn(
      `mcp: ${method} was still running ${STDIN_END_DRAIN_MS} ms after stdin closed; exiting without its reply`,
      { method },
    );
  }
}

async function exitWhenDrained(): Promise<void> {
  await drainInFlight();
  exitAfterFlush(0);
}

/** Answers `req` with one timeout error at the deadline a served request has. The returned function stops the timer and
 * says whether that answer went out, so a later reply is dropped. */
function watchDeadline(req: McpRequest, owedReply: boolean, abort: AbortController): () => boolean {
  const ms = requestDeadlineMs(envRequestDeadlineMs());
  if (ms === 0) return () => false;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    const name = callName(req);
    log.warn(`mcp: ${name} did not answer within ${ms} ms; its next step is cancelled and its reply will be dropped`, {
      method: req.method,
    });
    abort.abort(new DOMException(`${name} did not finish within ${ms} ms`, 'TimeoutError'));
    if (!owedReply) return;
    const requestId = currentRequestId();
    const message = `Request timed out: ${name} did not finish within ${ms} ms; a write it started may or may not be saved`;
    send(errorReply(req.id, REQUEST_TIMEOUT, message, requestId === undefined ? undefined : { requestId }));
  }, ms);
  // Stdin and the call keep the process alive; this timer alone must not.
  timer.unref();
  return () => {
    clearTimeout(timer);
    return expired;
  };
}

/** Zero-install first run (`npx -y hippo-memory mcp`, no store anywhere): create the global store instead of failing
 * every tool call, and say so on stderr (stdout carries the protocol). A later `hippo init` project store wins. */
function createGlobalStoreOnFirstRun(host: McpHost, tenantId: string): string {
  const root = getGlobalRoot();
  const target = host.contextFor(root, tenantId).reach?.globalTarget;
  // A host whose store is not hippo.db keeps no folder, so there is nothing to create.
  if (target === undefined) return root;
  target.store.localFiles.ensureFiles();
  log.warn(
    `no memory store found; created the global store at ${root}. Run \`hippo init\` in a project for a project store.`,
  );
  return root;
}

/** Runs one frame in the host's scope; only a tool call builds a context, so tools/list never creates a store. */
function handleFrame(req: McpRequest, host: McpHost): Promise<McpResponse | null> {
  return host.runRequest(() => {
    if (req.method !== 'tools/call') return handleMcpRequest(req, undefined);
    const tenantId = envTenant();
    const root = findHippoRoot() ?? createGlobalStoreOnFirstRun(host, tenantId);
    return handleMcpRequest(req, host.contextFor(root, tenantId));
  });
}

function dispatch(body: string, abort: AbortController, host: McpHost): void {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    log.debug('mcp: answered a frame that is not valid JSON with a parse error', errorFields(err));
    send(errorReply(null, PARSE_ERROR, 'Parse error'));
    return;
  }
  if (!isRoutableRequest(parsed)) {
    answerUnroutable(parsed);
    return;
  }
  const req = parsed;
  if (req.method.startsWith('notifications/')) {
    const stopWatching = watchDeadline(req, false, abort);
    track(
      req.method,
      handleFrame(req, host)
        .then(() => {})
        .catch((err) => {
          log.error(`mcp notification ${req.method} failed: ${errorMessage(err)}`, errorFields(err));
        })
        .finally(stopWatching),
    );
    return;
  }
  // A frame with no id is a notification under any method name, and JSON-RPC forbids answering one.
  const timedOut = watchDeadline(req, isJsonString(req.id) || isJsonNumber(req.id), abort);
  track(
    req.method,
    handleFrame(req, host)
      .then((resp) => {
        if (!timedOut() && resp) send(resp);
      })
      .catch((err) => {
        if (timedOut() && err instanceof DOMException && err.name === 'TimeoutError') {
          log.debug(`mcp: ${callName(req)} stopped at its deadline`, errorFields(err));
        } else if (timedOut()) {
          log.error(`mcp: ${callName(req)} failed after its timeout reply: ${errorMessage(err)}`, errorFields(err));
        } else send(mcpErrorResponse(req.id, err, undefined, callName(req)));
      }),
  );
}

/** Wires stdin/stdout to the dispatcher; idempotent. Only the entrypoint (cli.ts `hippo mcp`, or this file run
 * directly) should call it, so the HTTP daemon
 * (which imports `handleMcpRequest`) does not steal stdin or exit when its parent closes a pipe. The caller picks
 * the host, so src/mcp names no store adapter and no scope plumbing. */
export function startStdioLoop(host: McpHost): void {
  process.stdin.on('data', (raw: Buffer) => {
    const chunk = withoutRefused(raw);
    pending.push(chunk);
    pendingBytes += chunk.length;
    // Joining on every chunk would copy the whole pending frame each time; wait until a frame can have ended.
    if (needs === undefined ? !chunk.includes(0x0a) && pendingBytes <= MAX_BODY_BYTES : pendingBytes < needs) return;
    let buffer: Buffer = Buffer.concat(pending, pendingBytes);
    needs = undefined;
    while (true) {
      const result = parseFrame(buffer);
      if (result.kind === 'incomplete') {
        needs = result.needs;
        break;
      }
      buffer = result.rest;
      if (result.kind === 'oversize') {
        refused = result.remainder;
        log.warn('mcp: refused a frame over the size cap with a parse error');
        send(errorReply(null, PARSE_ERROR, 'Parse error: frame exceeds 1MB'));
        continue;
      }
      // One id per frame, so the error reply and every line logged for the call name the same request.
      if (result.kind === 'message') {
        const abort = new AbortController();
        runWithRequestId(randomUUID(), () => dispatch(result.body, abort, host), undefined, abort.signal);
      }
    }
    pending = buffer.length > 0 ? [buffer] : [];
    pendingBytes = buffer.length;
  });

  process.stdin.on('end', () => {
    exitWhenDrained().catch((err) => {
      log.error('mcp: draining the calls in flight failed; exiting', errorFields(err));
      exitAfterFlush(1);
    });
  });

  exitOnStreamError();
  // A crash waits for the calls in flight as stdin's end does, so a client is not left without its reply.
  installCrashHandlers('mcp', { run: drainInFlight, boundMs: STDIN_END_DRAIN_MS + CRASH_DRAIN_SLACK_MS });
}

function exitOnStreamError(): void {
  // A client that hangs up mid-reply makes the next write fail; an unhandled stream error would crash the server.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
      log.debug('mcp: the client closed stdout; exiting', errorFields(err));
      exitAfterFlush(0);
      return;
    }
    log.error(`mcp: stdout failed: ${errorMessage(err)}`, errorFields(err));
    exitAfterFlush(1);
  });

  // A closed stderr cannot carry a log line, so the loop leaves quietly; any other fault is an exit code.
  process.stderr.on('error', (err: NodeJS.ErrnoException) => {
    exitAfterFlush(err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED' ? 0 : 1);
  });
}
