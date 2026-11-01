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
import { DEFAULT_TENANT_ID } from '../../base/util/tenant.js';
import { errorReply, INTERNAL_ERROR, type McpRequest, type McpResponse } from './json-rpc.js';
import type { CallerProject } from '../../api/prompt-hook.js';
import type { HippoStore } from '../../base/ports/store-index.js';
import type {
  GlobalTargetGroup,
  OptionalGroup,
  RequiredStore,
  StoreWith,
} from '../../base/ports/store.js';
import type { ContextWith } from '../../api/types.js';
import type { ConfiguredFolder } from '../../base/config/configured-folder.js';
import type { CallerState } from '../../api/callers.js';
import type { InfraPorts } from '../../base/ports/infra.js';
import type { DetachedWork } from '../../domain/search/detached-work.js';

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
export interface McpCaller<S extends RequiredStore = RequiredStore> {
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
  /** The outside services the transport's root built; every tool call's api Context carries
   * them. */
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
export type StoreTool<S extends RequiredStore> = (ctx: McpCaller<S>) => ToolRun | undefined;

/** The tools a host serves, by name; a tool its store lacks a group for is absent. */
export type McpTools<S extends RequiredStore> = ReadonlyMap<string, StoreTool<S>>;

/** A tool call's caller and the tools its host bound once, at boot. */
export interface McpContext<S extends RequiredStore = RequiredStore> extends McpCaller<S> {
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

/** The api Context a tool call runs as: the transport's store, reach and config under the
 * caller's actor. */
export function mcpApiContext(ctx: McpCaller): ApiContext {
  return {
    tenantId: ctx.tenantId,
    actor: mcpActor(ctx),
    store: ctx.store,
    reach: ctx.reach,
    config: ctx.config,
    callers: ctx.callers,
    clientKey: mcpClientKey(ctx),
    infra: ctx.infra,
    signal: ctx.signal,
    detached: ctx.detached,
  };
}

/** The transport's client key, else `stdio-<pid>:<tenant>`; a caller's project narrows either,
 * so two repos on one shared store keep apart lists. */
function mcpClientKey(ctx: McpCaller): string {
  const base = ctx.clientKey || `stdio-${process.pid}:${ctx.tenantId || DEFAULT_TENANT_ID}`;
  return ctx.project ? `${base}:${ctx.project.name}` : base;
}

/** Stdio or a host admin: the only callers whose server cwd and git history are their own to
 * read. */
export function ownsServerCwd(ctx: McpCaller | undefined): boolean {
  return mcpActor(ctx).hostAdmin === true;
}

// ── JSON-ish domain type for untrusted MCP tool-call arguments ──

/** The context of a tool call on a folder, built by the frame's composition root. */
export type McpContextFor<S extends RequiredStore = RequiredStore> = (
  hippoRoot: string,
  tenantId: string,
) => McpContext<S>;

/** What the stdio transport takes from its composition root: one frame's run, whose contexts
 * share the frame's store handles and carry `signal`. The root names the store adapter, so
 * src/surface/mcp does not. */
export interface McpHost<S extends RequiredStore = RequiredStore> {
  runFrame<T>(signal: AbortSignal, run: (contextFor: McpContextFor<S>) => Promise<T>): Promise<T>;
  /** Waits up to `withinMs` for the work the frames handed off, such as an embed; resolves with
   * how many were still running. */
  settle(withinMs: number): Promise<number>;
}

/** One tool call after the store, config and tenant are resolved; every handler reads the same
 * five. */
export interface ToolCall {
  args: Record<string, JsonValue>;
  ctx: McpCaller;
  hippoRoot: string;
  store: RequiredStore;
  config: HippoConfig;
  tenantId: string;
}

export type ToolHandler = (call: ToolCall) => string | Promise<string>;

/** A call on a store boot proved holds the optional groups `G`, and the api Context it runs as
 * on that store. */
export interface GroupToolCall<G extends OptionalGroup> extends ToolCall {
  store: StoreWith<G>;
  api: ContextWith<G>;
}

export type GroupToolHandler<G extends OptionalGroup> = (
  call: GroupToolCall<G>,
) => string | Promise<string>;

/** A share or peers call: a folder store and the global store its reach names, both checked by
 * the gate. */
export interface LocalToolCall extends ToolCall {
  store: StoreWith<'folderFiles'>;
  globalTarget: ConfiguredFolder<StoreWith<GlobalTargetGroup>>;
}

export type LocalToolHandler = (call: LocalToolCall) => string | Promise<string>;
