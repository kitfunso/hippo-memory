// MCP wire types, the caller context, and the JSON predicates every tool handler narrows its arguments with.

import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import { INTERNAL_ERROR_MESSAGE, mapApiError } from '../util/http-util.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { currentRequestId } from '../util/request-scope.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import { loadConfig } from '../core/config.js';
import type { Actor as ApiActor } from '../api/index.js';
import { findHippoStoreDir, type ResolveProjectIdentityOpts } from '../core/project-identity.js';
import { isStoreBusy, STORE_BUSY_MESSAGE } from '../db/index.js';
import { type JsonValue } from '../util/json.js';
import type { CallerProject } from '../api/prompt-hook.js';
import type { HippoStore } from '../store/index.js';

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
  // Kept as Record<string, JsonValue>: wire params are always parsed JSON, and every read of `params` (tools/call below) narrows via the isJson* predicates
  // first.
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
export function mcpErrorResponse<E>(id: McpResponse['id'], err: E, requestId: string = currentRequestId() ?? randomUUID()): McpResponse {
  if (isStoreBusy(err)) return { jsonrpc: '2.0', id, error: { code: -32603, message: STORE_BUSY_MESSAGE } };
  const { status, message } = mapApiError(err);
  if (status !== 500) return { jsonrpc: '2.0', id, error: { code: -32603, message } };
  log.error(`mcp request failed: ${errorMessage(err)}`, { requestId, ...errorFields(err) });
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message: `${INTERNAL_ERROR_MESSAGE} (request id ${requestId})`, data: { requestId } },
  };
}

export type { McpRequest, McpResponse };

/** Optional context from a non-stdio transport (the HTTP server's bound hippoRoot and auth-resolved tenantId/actor), so executeTool skips the
 * findHippoRoot() walk and the env-based resolveTenantId({}) fallback, which would pick the wrong store and tenant for HTTP callers. Stdio passes nothing. */
export interface McpContext {
  hippoRoot: string;
  tenantId: string;
  actor: string;
  /** The caller's authenticated role. Required so no transport can forget it; only stdio, which passes no context, is admin without one. */
  role: 'admin' | 'member';
  /** Scope grants for the HTTP-MCP caller's key. Absent for stdio (admin, needs none). */
  scopes?: readonly string[];
  viaAuthResolver?: true;
  /** Set by the HTTP transport for the host's operator; never implied by the role. */
  hostAdmin?: true;
  owner?: string; // copied by mcpActor so MCP task state keys the same as REST
  project?: CallerProject; // from X-Hippo-Project on a shared store: stamps writes, filters reads, keys outcomes
  store?: HippoStore;
  autoSleep?: false;
  /** Per-client key for state isolation under HTTP-MCP: 'stdio-${pid}' for stdio, hash(bearer + remoteAddr) for HTTP (built in src/server/mcp-http.ts);
   * defaults to `${tenantId}:default`. */
  clientKey?: string;
}

/** The api-layer actor for a tool call. Only stdio passes no context: it is the local operator, host admin. Any context runs as its own role, and an
 * untyped caller that sends none runs as a member, so a missing role fails closed. */
export function mcpActor(ctx: McpContext | undefined): ApiActor {
  if (ctx === undefined) return { subject: 'mcp', role: 'admin', hostAdmin: true };
  const actor: ApiActor = { subject: ctx.actor ?? 'mcp', role: ctx.role === 'admin' ? 'admin' : 'member', scopes: ctx.scopes };
  if (ctx.viaAuthResolver) actor.viaAuthResolver = true;
  if (ctx.hostAdmin) actor.hostAdmin = true;
  if (ctx.owner !== undefined) actor.owner = ctx.owner;
  return actor;
}

/** Stdio or a host admin: the only callers whose server cwd and git history are their own to read. */
export function ownsServerCwd(ctx: McpContext | undefined): boolean {
  return mcpActor(ctx).hostAdmin === true;
}

// ── JSON-ish domain type for untrusted MCP tool-call arguments ──

/** One tool call after the store, config and tenant are resolved; every handler reads the same four. */
export interface ToolCall {
  args: Record<string, JsonValue>;
  ctx?: McpContext;
  hippoRoot: string;
  config: ReturnType<typeof loadConfig>;
  tenantId: string;
}

export type ToolHandler = (call: ToolCall) => string | Promise<string>;
