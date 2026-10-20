// JSON-RPC 2.0 wire types, the error codes, and the one place a reply is built, so no transport words a reply twice.
import type { JsonValue } from '../../base/util/json.js';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
// The code the MCP SDKs give a request that timed out.
export const REQUEST_TIMEOUT = -32001;

export interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  // Kept as Record<string, JsonValue>: wire params are always parsed JSON, and every read of `params` (tools/call
  // below) narrows via the isJson* predicates first.
  params?: Record<string, JsonValue>;
}

export interface McpResponse {
  jsonrpc: '2.0';
  // JSON-RPC answers a frame it could not parse with id null.
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: { requestId: string } };
}

export function resultReply(id: McpResponse['id'], result: McpResponse['result']): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

export function errorReply(
  id: McpResponse['id'],
  code: number,
  message: string,
  data?: { requestId: string },
): McpResponse {
  const error: NonNullable<McpResponse['error']> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}
