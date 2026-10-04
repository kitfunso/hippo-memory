// MCP wire types, the caller context, and the JSON predicates every tool handler narrows its arguments with.

import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import { INTERNAL_ERROR_MESSAGE, mapApiError } from '../http-util.js';
import { log } from '../log.js';
import { getGlobalRoot } from '../shared.js';
import { loadConfig } from '../config.js';
import type { Actor as ApiActor } from '../api.js';
import { findHippoStoreDir, type ResolveProjectIdentityOpts } from '../project-identity.js';
import { isSqliteBusy, STORE_BUSY_MESSAGE } from '../db.js';

// ── Find hippo root ──

/** Same bounded walk as the CLI (ends at home, so HIPPO_HOME wins over ~/.hippo); cwd/opts are the test seam. */
export function findHippoRoot(cwd: string = process.cwd(), opts?: ResolveProjectIdentityOpts): string | null {
  const local = findHippoStoreDir(cwd, opts);
  if (local !== null) return local;
  // Global fallback (respects $HIPPO_HOME / $XDG_DATA_HOME)
  const global = getGlobalRoot();
  return fs.existsSync(global) ? global : null;
}

// ── MCP protocol types ──

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  // NOTE: kept as Record<string, unknown> (not narrowed to a JsonValue
  // Wire params are always parsed JSON, so the value domain is JsonValue;
  // every read of `params` (the tools/call case below) still narrows via
  // the isJson* predicates before use.
  params?: Record<string, JsonValue>;
}

interface McpResponse {
  jsonrpc: '2.0';
  // JSON-RPC answers a frame it could not parse with id null.
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: { requestId: string } };
}

/** JSON-RPC reply for a request that threw: typed API errors keep their text; anything else is logged and answered generically. */
export function mcpErrorResponse<E>(id: McpResponse['id'], err: E, requestId: string = randomUUID()): McpResponse {
  if (isSqliteBusy(err)) return { jsonrpc: '2.0', id, error: { code: -32603, message: STORE_BUSY_MESSAGE } };
  const { status, message } = mapApiError(err);
  if (status !== 500) return { jsonrpc: '2.0', id, error: { code: -32603, message } };
  log.error(`mcp request failed: ${err instanceof Error ? err.message : String(err)}`, { requestId });
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message: `${INTERNAL_ERROR_MESSAGE} (request id ${requestId})`, data: { requestId } },
  };
}

export type { McpRequest, McpResponse };

/**
 * Optional execution context threaded from a non-stdio transport. When the
 * HTTP transport in src/server.ts calls handleMcpRequest, it knows the
 * server's bound hippoRoot and the auth-resolved tenantId/actor. Passing
 * those through here lets executeTool skip the findHippoRoot() walk and
 * the env-based resolveTenantId({}) fallback — both of which would
 * otherwise produce the wrong store and the wrong tenant for HTTP callers.
 *
 * Stdio callers pass nothing; behavior stays unchanged for that path.
 */
export interface McpContext {
  hippoRoot: string;
  tenantId: string;
  actor: string;
  /**
   * The caller's role from the HTTP transport's auth. Absent for stdio, which
   * is the local operator and runs as admin. Tools must use this rather than
   * assuming admin, or a member key over HTTP-MCP would act as admin.
   */
  role?: 'admin' | 'member';
  /** EI2: scope grants for the HTTP-MCP caller's key. Absent for stdio (admin, needs none). */
  scopes?: readonly string[];
  viaAuthResolver?: true;
  /** Set by the HTTP transport for the host's operator; a context without a role is in-process and implies it. */
  hostAdmin?: true;
  /**
   * Per-client key for state isolation under HTTP-MCP. For stdio: 'stdio-${pid}'
   * (one process = one client). For HTTP-SSE / HTTP MCP: hash(bearer + remoteAddr)
   * built by src/server.ts when constructing McpContext for the request.
   * Optional for backwards compatibility; defaults to `${tenantId}:default`.
   */
  clientKey?: string;
}

/**
 * The api-layer actor for a tool call. Stdio (no ctx) is the local operator
 * and runs as admin; over HTTP the transport's authenticated role is used, so
 * a member key never acts as admin through MCP.
 */
export function mcpActor(ctx: McpContext | undefined): ApiActor {
  const actor: ApiActor = { subject: ctx?.actor ?? 'mcp', role: ctx?.role ?? 'admin', scopes: ctx?.scopes };
  if (ctx?.viaAuthResolver) actor.viaAuthResolver = true;
  if (ctx?.role === undefined || ctx.hostAdmin) actor.hostAdmin = true;
  return actor;
}

// ── JSON-ish domain type for untrusted MCP tool-call arguments ──

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function isJsonString(v: JsonValue | undefined): v is string {
  return typeof v === 'string';
}

export function isJsonBoolean(v: JsonValue | undefined): v is boolean {
  return typeof v === 'boolean';
}

export function isJsonObjectRecord(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return v !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** One tool call after the store, config and tenant are resolved; every handler reads the same four. */
export interface ToolCall {
  args: Record<string, JsonValue>;
  ctx?: McpContext;
  hippoRoot: string;
  config: ReturnType<typeof loadConfig>;
  tenantId: string;
}

export type ToolHandler = (call: ToolCall) => string | Promise<string>;
