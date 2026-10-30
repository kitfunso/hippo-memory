// Public option and handle types for serve(), plus the /v1 route shape.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context, EntryContext } from '../../api/index.js';
import type { ContextWith } from '../../api/types.js';
import type { HippoDbContext } from '../../api/hippo-db-context.js';
import type { JsonValue } from '../../base/util/json.js';
import type { RateLimiter } from './rate-limit.js';
import type { RouteLookup } from './route-lookup.js';
import type { BoundAddonRoute } from './route-table.js';
import type { HippoStore, OptionalGroup, StoreGroup } from '../../base/ports/store-index.js';
import type { RequiredStore, StoreReach } from '../../base/ports/store.js';
import type { McpTools } from '../mcp/protocol.js';
import type { LocalKey } from './local-key.js';
import type { KeyVerifier } from './api-key.js';
import type { ConfigReader } from '../../host/config-file.js';
import type { CallerState } from '../../api/callers.js';
import type { SleepQueue } from './sleep-offload.js';
import type { InfraPorts } from '../../base/ports/infra.js';
import type { DetachedWork } from '../../domain/search/detached-work.js';
import type { ConnectorStore } from '../connectors/ingest.js';

export interface ServerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
  /** Introspection-only: the underlying node:http Server, so tests can assert keep-alive/headers
   * timeout hardening without reaching into serve()'s closure. Do not use for control flow. */
  server?: import('node:http').Server;
}

/** Identity an {@link AuthResolver} vouches for. The core sanitises it before use. */
export interface ResolvedBearer {
  tenantId: string;
  subject: string;
  /** Not 'admin' means 'member'. Admin is tenant-only, yet can mint member API keys (POST
   * /v1/auth/keys); an add-on revokes them through the exported authRevoke when the IdP
   * deprovisions the minter. */
  role: 'admin' | 'member';
  scopes?: readonly string[];
}

/** Sole judge of non-`hk_` bearer tokens: null is a 401; a throw or missed deadline is a 503, so
 * throw only when upstream is down. */
export type AuthResolver = (
  token: string,
  /** Aborted when the deadline passes, so a slow upstream call can stop. */
  signal?: AbortSignal,
) => ResolvedBearer | null | Promise<ResolvedBearer | null>;

/** What an add-on route's handler gets: the caller core authenticated and the parsed JSON body. */
export interface AddonCall {
  readonly ctx: EntryContext;
  readonly body: Readonly<Record<string, JsonValue>>;
}

/** A POST /v1 route an add-on mounts through serve(): core authenticates and parses first, then
 * sends the returned value as 200 JSON. Unset, `storeReady` means the route runs on hippo.db
 * alone. */
export interface AddonRoute {
  readonly path: string;
  readonly handler: (call: AddonCall) => Promise<JsonValue>;
  readonly storeReady?: StoreGroup;
}

export interface RateLimitSpec {
  ratePerSec: number;
  burst: number;
}

export interface ServeOptions {
  hippoRoot: string;
  /** Runs on every request and SSE heartbeat, so keep it cache-backed; API keys never reach it. */
  authResolver?: AuthResolver;
  /** Deadline for one authResolver call; defaults to 5000 ms, as does a value that is not a
   * positive number. */
  authResolverTimeoutMs?: number;
  port?: number;
  host?: string;
  /** Only `hippo serve` sets this: stop and exit on SIGINT/SIGTERM, and drain then exit 1 on an
   * uncaught exception or rejection. A stop 10000 ms past `shutdownDrainMs` exits as a failure. */
  handleSignals?: boolean;
  /** How long stop() lets in-flight requests finish before closing their sockets; defaults to
   * 5000 ms. */
  shutdownDrainMs?: number;
  /** How long a request may stay unanswered before one warn names it; the request itself is left
   * alone. Defaults to 60000 ms. */
  slowRequestWarnMs?: number;
  /** Defaults to hippo.db under `hippoRoot`. A store of another kind runs only the routes ported
   * to it; its caller closes it. */
  store?: HippoStore;
  autoSleep?: false;
  routes?: readonly AddonRoute[];
  /** Tests only: shortens the wait for a key-mint body, which defaults to 10000 ms. */
  mintBodyDeadlineMs?: number;
  /** Tests only: shortens the wait for a signed webhook's body, which defaults to 10000 ms. */
  webhookBodyDeadlineMs?: number;
  /** PEM certificate and key: serve() then answers HTTPS only. Unset means cleartext
   * HTTP, which needs a TLS-terminating proxy in front on any non-loopback bind. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** Lets a non-loopback bind start without `tls`, for TLS that ends at a proxy in front; else
   * serve() refuses it. Also HIPPO_ALLOW_CLEARTEXT=1. */
  allowCleartext?: boolean;
  /** Static JSON served to anyone at GET <path>; built once at boot and never authenticated, so
   * it must hold nothing secret. */
  publicJson?: Readonly<Record<string, JsonValue>>;
  /** Request limits, each disabled by 'off': perCaller after auth, on by default (HIPPO_CALLER_RPS,
   * else 20/s, burst 2x); perAddress replaces HIPPO_V1_RPS; failedAuthPerAddress guards scrypt. */
  rateLimits?: {
    perCaller?: RateLimitSpec | 'off';
    perAddress?: RateLimitSpec | 'off';
    failedAuthPerAddress?: RateLimitSpec;
  };
}

/** Counts this server's /health reports, since it started. */
export interface ServerCounts {
  /** Requests answered 504 by the handler deadline. */
  handlerDeadlines: number;
  /** Background sleeps its writes started. */
  autoSleeps: number;
}

export type ResolvedServeOptions = ServeOptions & {
  store: HippoStore;
  /** The store is hippo.db rather than a caller's own: its folder's config.json decides
   * shared-ness, and an add-on route naming no group runs on it alone. */
  onHippoDb: boolean;
  /** What a request's store call reaches, probed per request (`shared` is the transport's flag). */
  reachOf: (shared: boolean) => StoreReach;
  /** A store the server built at boot, as this request calls it: each call to a worker waits on
   * its deadline. */
  storeFor: <S extends HippoStore>(store: S) => S;
  /** Fires when this request passes its deadline; unset outside a request and for an exempt
   * route. */
  signal?: AbortSignal;
  /** This server's own config reader: each request reads config.json through it. */
  configAt: ConfigReader;
  publicJsonBodies: ReadonlyMap<string, string>;
  /** The /v1 rows for this store, each row's store need settled at boot. */
  v1Routes: RouteLookup<BoundRoute>;
  /** The MCP tools this store serves, each tool's store need settled at boot. */
  mcpTools: McpTools<RequiredStore>;
  /** The add-on routes by path, each with its store need settled at boot. */
  addonRoutes: ReadonlyMap<string, BoundAddonRoute>;
  callerLimiter?: RateLimiter;
  failedAuthLimiter: RateLimiter;
  /** The local key this server issued at boot, which the CLI and hooks on its machine send. */
  localKey: LocalKey;
  /** This server's key checks: the tokens it proved and the derivations it runs. */
  keyVerifier: KeyVerifier;
  /** This server's per-caller state, handed to every request's Context. */
  callers: CallerState;
  /** `callers` as one request reads them: the auto-sleep count runs on the request's own store,
   * which `storeFor` maps. */
  callersFor: (storeFor: <S extends HippoStore>(store: S) => S) => CallerState;
  /** This server's outside services: one reranker registry for the server's life, the rest per
   * Context. */
  infra: () => InfraPorts;
  /** Keeps the work a request starts and does not wait on; the server's stop settles it. */
  detached: DetachedWork;
  sleeps: SleepQueue;
  counts: ServerCounts;
};

/** Per-request values the /v1 route handlers read. */
export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  opts: ResolvedServeOptions;
  query: URLSearchParams;
}

/** A request past the dispatch gate, carrying the caller the gate authenticated. */
export interface AuthedRouteRequest extends RouteRequest {
  ctx: Context;
}

/** A request past the gate whose store boot proved holds the optional groups `G`. */
export type GroupRequest<G extends OptionalGroup> = AuthedRouteRequest & { ctx: ContextWith<G> };

/** A request past the gate on a store boot proved holds hippo.db's local tier. */
export type HippoDbRequest = AuthedRouteRequest & { ctx: HippoDbContext };

/** A connector webhook's request, with the connector store boot proved; the handler checks the
 * sender itself. */
export interface WebhookRouteRequest extends RouteRequest {
  readonly store: ConnectorStore;
}

/** What the dispatch gate proves before a handler runs: any caller, an admin, a host admin on
 * loopback, nothing, for a route whose handler checks the sender's signature itself, or the
 * dashboard's session, which only its rows take. */
export type RouteAuth =
  | 'caller'
  | 'admin'
  | 'host-admin-local'
  | 'webhook-signature'
  | 'dashboard-session';

/** The gates a /v1 row's caller passes before its handler runs. */
type GatedAuth = Exclude<RouteAuth, 'webhook-signature' | 'dashboard-session'>;

/** A pattern row's params by name; a `:name(int)` value holds digits only. */
export type RouteParams = Readonly<Record<string, string>>;

/** An exact path, or a pattern whose `:name` segments arrive as params, each paired with one
 * method's handler. */
export type PathEndpoint<R> =
  | { path: string; handler: (r: R) => Promise<void> }
  | { pattern: string; handler: (r: R, params: RouteParams) => Promise<void> };

/** The dashboard's app pages also take any path outside its JSON API, which an expression says
 * and a pattern cannot. */
export type RouteEndpoint<R> =
  | PathEndpoint<R>
  | { regex: RegExp; handler: (r: R, match: RegExpMatchArray) => Promise<void> };

/** A route as the gate runs it, its store need already settled at boot. */
export type BoundRoute = { method: string; unported?: true } & (
  | ({ auth: GatedAuth } & PathEndpoint<AuthedRouteRequest>)
  | ({ auth: 'webhook-signature' } & PathEndpoint<RouteRequest>)
);

/** A route that runs on any store. */
type AnyStoreRoute = {
  method: string;
  auth: GatedAuth;
  storeReady?: never;
  hippoDb?: never;
} & PathEndpoint<AuthedRouteRequest>;

/** A route that needs the optional group `G`: boot hands its handler the store it proved, or
 * marks the row 501. */
export type GroupRouteOf<G extends OptionalGroup> = {
  method: string;
  auth: GatedAuth;
  storeReady: G;
  hippoDb?: never;
} & PathEndpoint<GroupRequest<G>>;

/** A route that needs any one optional group. */
export type GroupRoute = { [G in OptionalGroup]: GroupRouteOf<G> }[OptionalGroup];

/** A connector webhook: boot hands it the connector store it proved, or answers 501 for a store
 * without one. */
export type WebhookRoute = {
  method: string;
  auth: 'webhook-signature';
  storeReady?: never;
  hippoDb?: never;
} & PathEndpoint<WebhookRouteRequest>;

/** A route on hippo.db's local tier: boot hands its handler the request's tier, or marks the row
 * 501 on a store without it. */
export type HippoDbRoute = {
  method: string;
  auth: GatedAuth;
  storeReady?: never;
  /** The handler calls the local tier, so the row binds only on a store that carries `hippoDb`. */
  hippoDb: true;
} & PathEndpoint<HippoDbRequest>;

/** One /v1 route: an exact path or a matchPath pattern, paired with one method's handler. Under
 * another store it runs only with its `storeReady` group, and a `hippoDb` row not at all; its
 * hippo.db work runs on a worker thread when the store has one. */
export type Route = AnyStoreRoute | GroupRoute | WebhookRoute | HippoDbRoute;
