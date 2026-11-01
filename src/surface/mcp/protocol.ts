// MCP wire types, the caller context, and the JSON predicates every tool handler narrows its
// arguments with.

import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mapApiError } from '../../api/error-reply.js';
import { INTERNAL_ERROR_MESSAGE } from '../../base/errors/http-errors.js';
import { errorClassFields, errorFields, errorMessage, log } from '../../base/util/log.js';
import { currentRequestId } from '../../base/util/request-scope.js';
import type { HippoConfig } from '../../base/config/config.js';
import type { Actor as ApiActor, Context as ApiContext, ContextReach } from '../../api/index.js';
import { type ResolveProjectIdentityOptions } from '../../base/scope/project-identity.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { findHippoStoreDir } from '../../host/project-identity.js';
import { type JsonValue, isJsonString } from '../../base/util/json.js';
import { errorReply, INTERNAL_ERROR, type McpRequest, type McpResponse } from './json-rpc.js';
import type { CallerProject } from '../../api/prompt-hook.js';
import type { HippoStore } from '../../base/ports/store-index.js';
import type { HippoDbContext } from '../../api/hippo-db-context.js';
import type { HippoDbStore } from '../../base/ports/hippo-db.js';
import type { ConfiguredFolder } from '../../base/ports/store.js';
import type { CallerState } from '../../api/callers.js';
import type { InfraPorts } from '../../base/ports/infra.js';
import type { DetachedWork } from '../../domain/search/embed-memories.js';

/** Same bounded walk as the CLI (ends at home, so HIPPO_HOME wins over ~/.hippo); cwd/opts are
 * the test seam. */
export function findHippoRoot(
  cwd: string = process.cwd(),
  opts?: ResolveProjectIdentityOptions,
): string | null {
  const local = findHippoStoreDir(cwd, opts);
  if (local !== null) return local;
  // Global fallback (respects $HIPPO_HOME / $XDG_DATA_HOME)
  const global = hippoHomeDir();
  return fs.existsSync(global) ? global : null;
}

/** The method, with the tool's name for a tool call, so a failure or timeout names what ran. */
export function callName(req: McpRequest): string {
  const tool = req.params?.name;
  return isJsonString(tool) ? `${req.method} ${tool.slice(0, 128)}` : req.method;
}

/** JSON-RPC reply for a request that threw: typed API errors keep their text; anything else is
 * logged and answered generically. */
export function mcpErrorResponse<E>(
  id: McpResponse['id'],
  err: E,
  requestId: string = currentRequestId() ?? randomUUID(),
  call?: string,
): McpResponse {
  const where = call === undefined ? '' : ` (${call})`;
  const { status, message } = mapApiError(err);
  if (status === 503) {
    log.warn(`mcp request${where} failed: ${errorMessage(err)}`, {
      requestId,
      ...errorFields(err),
    });
    return errorReply(id, INTERNAL_ERROR, message);
  }
  if (status !== 500) {
    log.trail(`mcp request${where} failed: ${errorMessage(err)}`, {
      requestId,
      status,
      ...errorClassFields(err),
    });
    return errorReply(id, INTERNAL_ERROR, message);
  }
  log.error(`mcp request${where} failed: ${errorMessage(err)}`, { requestId, ...errorFields(err) });
  return errorReply(id, INTERNAL_ERROR, `${INTERNAL_ERROR_MESSAGE} (request id ${requestId})`, {
    requestId,
  });
}

export type { McpRequest, McpResponse };

/** One tool call's caller, as the transport bound it: the HTTP server's hippoRoot and
 * auth-resolved tenantId/actor, or the stdio host's folder walk and HIPPO_TENANT. */
export interface McpCaller<S extends HippoStore = HippoStore> {
  hippoRoot: string;
  tenantId: string;
  actor: string;
  /** The caller's authenticated role. Required so no transport can forget it; only stdio, which
   * passes no context, is admin without one. */
  role: 'admin' | 'member';
  /** Scope grants for the HTTP-MCP caller's key. Absent for stdio (admin, needs none). */
  scopes?: readonly string[];
  viaAuthResolver?: true;
  /** Set by the HTTP transport for the host's operator; never implied by the role. */
  hostAdmin?: true;
  owner?: string; // copied by mcpActor so MCP task state keys the same as REST
  project?: CallerProject; // from X-Hippo-Project on a shared store: stamps writes, filters reads, keys outcomes
  /** The store this transport's calls run on. */
  store: S;
  /** A store the host proved at boot, as this call reaches it (a request's view on HTTP). */
  storeFor: <T extends HippoStore>(own: T) => T;
  /** The store's config, loaded by the transport's root for this call. */
  config: HippoConfig;
  /** Set by the stdio host: the operator's own process, so no shared-store gate applies. */
  stdio?: true;
  reach?: ContextReach;
  /** The transport root's per-caller state; without it no session ring, last-shown list or
   * auto-sleep is kept. */
  callers?: CallerState;
  /** The outside services the transport's root built; every tool call's api Context
   * carries them. */
  infra: InfraPorts;
  /** Per-client key for state isolation under HTTP-MCP, a hash of bearer and address built in
   * src/surface/server/mcp-http.ts; absent on stdio, which keys by process and tenant. */
  clientKey?: string;
  /** Aborts when the call passes its deadline, so a tool stops starting work nobody waits for. */
  signal?: AbortSignal;
  /** The transport root's keeper of work a call does not wait on; unset, each call waits for it. */
  detached?: DetachedWork;
}

/** A tool's run for one call's arguments. */
export type ToolRun = (args: Record<string, JsonValue>) => string | Promise<string>;

/** A tool bound to one host: its run for a call, or undefined when the call's reach has no
 * global store for it. */
export type StoreTool<S extends HippoStore> = (ctx: McpCaller<S>) => ToolRun | undefined;

/** The tools a host serves, by name; a local tool is absent on a store without hippo.db's local
 * tier, so a client never lists a tool that could only refuse. */
export type McpTools<S extends HippoStore> = ReadonlyMap<string, StoreTool<S>>;

/** A tool call's caller and the tools its host bound once, at boot. */
export interface McpContext<S extends HippoStore = HippoStore> extends McpCaller<S> {
  tools: McpTools<S>;
}

/** The api-layer actor for a tool call. Only stdio passes no context: it is the local operator,
 * host admin. Any context runs as its own role, and an untyped caller that sends none runs as a
 * member, so a missing role fails closed. */
export function mcpActor(ctx: McpCaller | undefined): ApiActor {
  if (ctx === undefined) return { subject: 'mcp', role: 'admin', hostAdmin: true };
  const actor: ApiActor = {
    subject: ctx.actor ?? 'mcp',
    role: ctx.role === 'admin' ? 'admin' : 'member',
    scopes: ctx.scopes,
  };
  if (ctx.viaAuthResolver) actor.viaAuthResolver = true;
  if (ctx.hostAdmin) actor.hostAdmin = true;
  if (ctx.owner !== undefined) actor.owner = ctx.owner;
  return actor;
}

/** Stdio or a host admin: the only callers whose server cwd and git history are their own
 * to read. */
export function ownsServerCwd(ctx: McpCaller | undefined): boolean {
  return mcpActor(ctx).hostAdmin === true;
}

// ── JSON-ish domain type for untrusted MCP tool-call arguments ──

/** The context of a tool call on a folder, built by the frame's composition root. */
export type McpContextFor<S extends HippoStore = HippoStore> = (
  hippoRoot: string,
  tenantId: string,
) => McpContext<S>;

/** What the stdio transport takes from its composition root: one frame's run, whose contexts
 * share the frame's store handles and carry `signal`. The root names the store adapter, so
 * src/surface/mcp does not. */
export interface McpHost<S extends HippoStore = HippoStore> {
  runFrame<T>(signal: AbortSignal, run: (contextFor: McpContextFor<S>) => Promise<T>): Promise<T>;
  /** Waits up to `withinMs` for the work the frames handed off, such as an embed; resolves with
   * how many were still running. */
  settle(withinMs: number): Promise<number>;
}

/** One tool call after the store, config and tenant are resolved, with the api Context its root
 * built for it once. */
export interface ToolCall {
  args: Record<string, JsonValue>;
  ctx: McpCaller;
  api: ApiContext;
  hippoRoot: string;
  store: HippoStore;
  config: HippoConfig;
  tenantId: string;
}

export type ToolHandler = (call: ToolCall) => string | Promise<string>;

/** A local tool's call: the store boot proved holds hippo.db's local tier, and the api Context it
 * runs as on that store. */
export interface HippoDbToolCall extends ToolCall {
  store: HippoDbStore;
  api: HippoDbContext;
}

export type HippoDbToolHandler = (call: HippoDbToolCall) => string | Promise<string>;

/** A share or peers call: a folder store and the global store its reach names, both checked by
 * the gate. */
export interface LocalToolCall extends ToolCall {
  store: HippoDbStore;
  globalTarget: ConfiguredFolder<HippoDbStore>;
}

export type LocalToolHandler = (call: LocalToolCall) => string | Promise<string>;
