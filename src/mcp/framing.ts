// MCP stdio transport framing: newline-delimited JSON-RPC, no embedded newlines
// (https://modelcontextprotocol.io/specification/.../basic/transports#stdio). Legacy LSP-style
// `Content-Length` framing is also accepted so a printf-and-pipe smoke test still works.

import { MAX_BODY_BYTES } from '../http-util.js';

const HEADER_DELIM = Buffer.from('\r\n\r\n');
const EMPTY = Buffer.alloc(0);

/** What of a refused frame has not arrived yet: a byte count when its header declared one, else the rest of its line. */
export type FrameRemainder = number | 'line';

export type FrameResult =
  | { kind: 'message'; body: string; rest: Buffer }
  | { kind: 'skip'; rest: Buffer }
  // Over the cap POST /mcp puts on a body, so one client cannot make the process buffer without bound.
  | { kind: 'oversize'; rest: Buffer; remainder: FrameRemainder }
  | { kind: 'incomplete' };

export function parseFrame(buffer: Buffer): FrameResult {
  // Strip leading whitespace/newlines between messages.
  let start = 0;
  while (
    start < buffer.length &&
    (buffer[start] === 0x0a || buffer[start] === 0x0d ||
     buffer[start] === 0x20 || buffer[start] === 0x09)
  ) {
    start++;
  }
  if (start === buffer.length) return { kind: 'incomplete' };
  const trimmed = buffer.subarray(start);

  // LSP-style Content-Length framing.
  if (trimmed[0] === 0x43 /* 'C' */ || trimmed[0] === 0x63 /* 'c' */) {
    const headerEnd = trimmed.indexOf(HEADER_DELIM);
    if (headerEnd === -1) return trimmed.length > MAX_BODY_BYTES ? { kind: 'oversize', rest: EMPTY, remainder: 'line' } : { kind: 'incomplete' };
    const header = trimmed.subarray(0, headerEnd).toString('utf-8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return { kind: 'skip', rest: Buffer.from(trimmed.subarray(headerEnd + 4)) };
    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (contentLength > MAX_BODY_BYTES) {
      const end = bodyStart + contentLength;
      return { kind: 'oversize', rest: Buffer.from(trimmed.subarray(Math.min(end, trimmed.length))), remainder: Math.max(0, end - trimmed.length) };
    }
    if (trimmed.length < bodyStart + contentLength) return { kind: 'incomplete' };
    const body = trimmed.subarray(bodyStart, bodyStart + contentLength).toString('utf-8');
    return { kind: 'message', body, rest: Buffer.from(trimmed.subarray(bodyStart + contentLength)) };
  }

  // Newline-delimited JSON (MCP spec).
  const newlineIdx = trimmed.indexOf(0x0a);
  if (newlineIdx === -1) return trimmed.length > MAX_BODY_BYTES ? { kind: 'oversize', rest: EMPTY, remainder: 'line' } : { kind: 'incomplete' };
  const rest = Buffer.from(trimmed.subarray(newlineIdx + 1));
  if (newlineIdx > MAX_BODY_BYTES) return { kind: 'oversize', rest, remainder: 0 };
  const line = trimmed.subarray(0, newlineIdx).toString('utf-8').trimEnd();
  if (!line) return { kind: 'skip', rest };
  return { kind: 'message', body: line, rest };
}
