// Stdio transport: newline-delimited JSON-RPC frames in on stdin, replies out on stdout.

import { installCrashHandlers } from '../util/crash-handlers.js';
import { log } from '../log.js';
import { parseFrame } from './framing.js';
import { mcpErrorResponse, isJsonObjectRecord, type McpRequest, type McpResponse } from './protocol.js';
import { handleMcpRequest } from './request.js';
import { type JsonValue, isJsonString } from '../json.js';
import { randomUUID } from 'node:crypto';
import { runWithRequestId } from '../request-scope.js';

// MCP stdio transport spec: messages are newline-delimited JSON-RPC, no embedded newlines.
// https://modelcontextprotocol.io/specification/.../basic/transports#stdio
function send(msg: McpResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Stdio transport ──

let buffer: Buffer = Buffer.alloc(0);

// Only method is checked: handleMcpRequest narrows params where it reads them, as the HTTP transport does.
function isRoutableRequest(v: JsonValue): v is JsonValue & McpRequest {
  return isJsonObjectRecord(v) && isJsonString(v.method);
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
  // A frame without a string method cannot be routed; dropping it keeps a stray value from crashing the process.
  if (!isRoutableRequest(parsed)) return;
  const req = parsed;
  if (req.method.startsWith('notifications/')) {
    handleMcpRequest(req).catch((err) => {
      log.error(`mcp notification ${req.method} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return;
  }
  handleMcpRequest(req).then((resp) => { if (resp) send(resp); }).catch((err) => {
    send(mcpErrorResponse(req.id, err));
  });
}

/**
 * Wire stdin/stdout to the dispatcher. Idempotent — only the entrypoint
 * (cli.ts `hippo mcp`, or running this file directly) should call this.
 * src/server.ts imports `handleMcpRequest` without invoking this, so the
 * HTTP daemon does not steal stdin or exit when its parent closes a pipe.
 */
export function startStdioLoop(): void {
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const result = parseFrame(buffer);
      if (result.kind === 'incomplete') break;
      buffer = result.rest;
      // One id per frame, so the error reply and every line logged for the call name the same request.
      if (result.kind === 'message') runWithRequestId(randomUUID(), () => dispatch(result.body));
    }
  });

  process.stdin.on('end', () => process.exit(0));

  installCrashHandlers('mcp');
}
