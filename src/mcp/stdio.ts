// Stdio transport: newline-delimited JSON-RPC frames in on stdin, replies out on stdout.

import { exitAfterFlush, installCrashHandlers } from '../util/crash-handlers.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { requestDeadlineMs } from '../server/deadline.js';
import { parseFrame, type FrameRemainder } from './framing.js';
import { mcpErrorResponse, type McpRequest, type McpResponse } from './protocol.js';
import { handleMcpRequest } from './request.js';
import { type JsonValue, isJsonNumber, isJsonString, isJsonObject } from '../util/json.js';
import { randomUUID } from 'node:crypto';
import { currentRequestId, runWithRequestId } from '../util/request-scope.js';

// MCP stdio transport spec: messages are newline-delimited JSON-RPC, no embedded newlines.
// https://modelcontextprotocol.io/specification/.../basic/transports#stdio
function send(msg: McpResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Stdio transport ──

let buffer: Buffer = Buffer.alloc(0);
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

/** A frame that parsed but names no method: with an id it is a request owed an answer; without one it is a notification, which JSON-RPC forbids answering. */
function answerUnroutable(frame: JsonValue): void {
  const id = isJsonObject(frame) ? frame.id : undefined;
  if (isJsonString(id) || isJsonNumber(id)) {
    send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: method must be a string' } });
    return;
  }
  log.warn('mcp: dropped a frame with no method and no id; it cannot be routed or answered');
}

/** How long stdin's end waits for calls still running, so a client that closes right after its last request still gets the reply. */
const STDIN_END_DRAIN_MS = 5000;

// Calls dispatched and not yet answered, each with the method the drain names if it is still running at the bound.
const inFlight = new Map<Promise<void>, string>();

function track(method: string, call: Promise<void>): void {
  inFlight.set(call, method);
  void call.finally(() => inFlight.delete(call));
}

async function exitWhenDrained(): Promise<void> {
  if (inFlight.size > 0) {
    let bound: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => { bound = setTimeout(resolve, STDIN_END_DRAIN_MS); });
    await Promise.race([Promise.allSettled(inFlight.keys()), timedOut]);
    clearTimeout(bound);
  }
  for (const method of inFlight.values()) {
    log.warn(`mcp: ${method} was still running ${STDIN_END_DRAIN_MS} ms after stdin closed; exiting without its reply`, { method });
  }
  exitAfterFlush(0);
}

// The code the MCP SDKs give a request that timed out.
const REQUEST_TIMEOUT_CODE = -32001;

/** The method, with the tool's name for a tool call, so a timeout names what ran. */
function callName(req: McpRequest): string {
  const tool = req.params?.name;
  return isJsonString(tool) ? `${req.method} ${tool.slice(0, 128)}` : req.method;
}

/** Answers `req` with one timeout error at the deadline a served request has. The returned function stops the timer and says whether that answer went out, so a later reply is dropped. */
function watchDeadline(req: McpRequest, owedReply: boolean): () => boolean {
  const ms = requestDeadlineMs();
  if (ms === 0) return () => false;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    const name = callName(req);
    log.warn(`mcp: ${name} did not answer within ${ms} ms; it keeps running and its reply will be dropped`, { method: req.method });
    if (!owedReply) return;
    const requestId = currentRequestId();
    const message = `Request timed out: ${name} did not finish within ${ms} ms; a write it started may or may not be saved`;
    const error: NonNullable<McpResponse['error']> = { code: REQUEST_TIMEOUT_CODE, message };
    if (requestId !== undefined) error.data = { requestId };
    send({ jsonrpc: '2.0', id: req.id, error });
  }, ms);
  // Stdin and the call keep the process alive; this timer alone must not.
  timer.unref();
  return () => {
    clearTimeout(timer);
    return expired;
  };
}

function dispatch(body: string): void {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body);
  } catch {
    log.debug('mcp: answered a frame that is not valid JSON with a parse error');
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRoutableRequest(parsed)) {
    answerUnroutable(parsed);
    return;
  }
  const req = parsed;
  if (req.method.startsWith('notifications/')) {
    const stopWatching = watchDeadline(req, false);
    track(req.method, handleMcpRequest(req).then(() => {}).catch((err) => {
      log.error(`mcp notification ${req.method} failed: ${errorMessage(err)}`, errorFields(err));
    }).finally(stopWatching));
    return;
  }
  // A frame with no id is a notification under any method name, and JSON-RPC forbids answering one.
  const timedOut = watchDeadline(req, isJsonString(req.id) || isJsonNumber(req.id));
  track(req.method, handleMcpRequest(req).then((resp) => { if (!timedOut() && resp) send(resp); }).catch((err) => {
    if (timedOut()) log.debug(`mcp: ${callName(req)} failed after its timeout reply: ${errorMessage(err)}`);
    else send(mcpErrorResponse(req.id, err));
  }));
}

/** Wires stdin/stdout to the dispatcher; idempotent. Only the entrypoint (cli.ts `hippo mcp`, or this file run directly) should call it, so the HTTP daemon
 * (which imports `handleMcpRequest`) does not steal stdin or exit when its parent closes a pipe. */
export function startStdioLoop(): void {
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, withoutRefused(chunk)]);
    while (true) {
      const result = parseFrame(buffer);
      if (result.kind === 'incomplete') break;
      buffer = result.rest;
      if (result.kind === 'oversize') {
        refused = result.remainder;
        log.warn('mcp: refused a frame over the size cap with a parse error');
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: frame exceeds 1MB' } });
        continue;
      }
      // One id per frame, so the error reply and every line logged for the call name the same request.
      if (result.kind === 'message') runWithRequestId(randomUUID(), () => dispatch(result.body));
    }
  });

  process.stdin.on('end', () => { void exitWhenDrained(); });

  installCrashHandlers('mcp');
}
