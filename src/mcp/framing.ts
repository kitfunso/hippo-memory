// MCP stdio transport framing.
//
// Spec: messages are newline-delimited JSON-RPC, with no embedded newlines.
//   https://modelcontextprotocol.io/specification/.../basic/transports#stdio
// We also accept legacy LSP-style `Content-Length` framing so the
// printf-and-pipe smoke test from issue #13 still works.

const HEADER_DELIM = Buffer.from('\r\n\r\n');

export type FrameResult =
  | { kind: 'message'; body: string; rest: Buffer }
  | { kind: 'skip'; rest: Buffer }
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
    if (headerEnd === -1) return { kind: 'incomplete' };
    const header = trimmed.subarray(0, headerEnd).toString('utf-8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return { kind: 'skip', rest: Buffer.from(trimmed.subarray(headerEnd + 4)) };
    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (trimmed.length < bodyStart + contentLength) return { kind: 'incomplete' };
    const body = trimmed.subarray(bodyStart, bodyStart + contentLength).toString('utf-8');
    return { kind: 'message', body, rest: Buffer.from(trimmed.subarray(bodyStart + contentLength)) };
  }

  // Newline-delimited JSON (MCP spec).
  const newlineIdx = trimmed.indexOf(0x0a);
  if (newlineIdx === -1) return { kind: 'incomplete' };
  const line = trimmed.subarray(0, newlineIdx).toString('utf-8').trimEnd();
  const rest = Buffer.from(trimmed.subarray(newlineIdx + 1));
  if (!line) return { kind: 'skip', rest };
  return { kind: 'message', body: line, rest };
}
