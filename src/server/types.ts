// Public option and handle types for serve(), plus the /v1 route shape.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ContextWith, StoreContext } from '../api/index.js';
import type { JsonValue } from '../util/json.js';
import type { RateLimiter } from './rate-limit.js';
import type { HippoStore, StoreGroup } from '../store/index.js';

export interface ServerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
  /** Introspection-only: the underlying node:http Server, so tests can assert keep-alive/headers timeout hardening
   * without reaching into serve()'s closure. Do not use for control flow. */
  server?: import('node:http').Server;
}

/** Identity an {@link AuthResolver} vouches for. The core sanitises it before use. */
export interface ResolvedBearer {
  tenantId: string;
  subject: string;
  /** Not 'admin' means 'member'. Admin is tenant-only, yet can mint member API keys (POST /v1/auth/keys);
   * an add-on revokes them through the exported authRevoke when the IdP deprovisions the minter. */
  role: 'admin' | 'member';
  scopes?: readonly string[];
}

/** Sole judge of non-`hk_` bearer tokens: null is a 401; a throw or missed deadline is a 503, so throw only when
 * upstream is down. */
export type AuthResolver = (token: string) => ResolvedBearer | null | Promise<ResolvedBearer | null>;

/** What an add-on route's handler gets: the caller core authenticated and the parsed JSON body. */
export interface AddonCall {
  readonly ctx: StoreContext;
  readonly body: Readonly<Record<string, JsonValue>>;
}

/** A POST /v1 route an add-on mounts through serve(): core authenticates and parses first, then sends the
 * returned value as 200 JSON. Under another store it runs only when that store has its `storeReady` group. */
export interface AddonRoute {
  readonly path: string;
  readonly handler: (call: AddonCall) => Promise<JsonValue>;
  readonly storeReady?: StoreGroup;
}

export interface RateLimitSpec { ratePerSec: number; burst: number }

export interface ServeOpts {
  hippoRoot: string;
  /** Runs on every request and SSE heartbeat, so keep it cache-backed; API keys never reach it. */
  authResolver?: AuthResolver;
  /** Deadline for one authResolver call; defaults to 5000 ms. */
  authResolverTimeoutMs?: number;
  port?: number;
  host?: string;
  /** Stop and exit on SIGINT/SIGTERM, and drain then exit 1 on an uncaught exception or unhandled rejection. A stop
   * still running 10 s past `shutdownDrainMs` ends the process with a failure exit. Only `hippo serve` sets this. */
  handleSignals?: boolean;
  /** How long stop() lets in-flight requests finish before closing their sockets; defaults to 5000 ms. */
  shutdownDrainMs?: number;
  /** How long a request may stay unanswered before one warn names it; the request itself is left alone. Defaults to
   * 60000 ms. */
  slowRequestWarnMs?: number;
  /** Defaults to hippo.db under `hippoRoot`. A store of another
   * kind runs only the routes ported to it; its caller closes it. */
  store?: HippoStore;
  autoSleep?: false;
  routes?: readonly AddonRoute[];
  mintBodyDeadlineMs?: number;
  /** Tests only: shortens the wait for a signed webhook's body, which defaults to 10 s. */
  webhookBodyDeadlineMs?: number;
  /** PEM certificate and key: serve() then answers HTTPS only. Unset means cleartext
   * HTTP, which needs a TLS-terminating proxy in front on any non-loopback bind. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** Lets a non-loopback bind start without `tls`, for TLS that ends at a
   * proxy in front; else serve() refuses it. Also HIPPO_ALLOW_CLEARTEXT=1. */
  allowCleartext?: boolean;
  /** The role a keyless local request (HIPPO_ALLOW_KEYLESS_LOCAL=1) gets; defaults to HIPPO_KEYLESS_LOCAL_ROLE, else
   * 'member'. Only 'admin' is host admin. */
  keylessLocalRole?: 'member' | 'admin';
  /** Static JSON served to anyone at GET <path>; built once at
   * boot and never authenticated, so it must hold nothing secret. */
  publicJson?: Readonly<Record<string, JsonValue>>;
  /** Request limits: perCaller after auth, on by default (HIPPO_CALLER_RPS, else 20 per second, burst 40); perAddress
   * replaces HIPPO_V1_RPS when set; 'off' disables either; failedAuthPerAddress guards scrypt. */
  rateLimits?: {
    perCaller?: RateLimitSpec | 'off';
    perAddress?: RateLimitSpec | 'off';
    failedAuthPerAddress?: RateLimitSpec;
  };
}

export type ResolvedServeOpts = ServeOpts & {
  store: HippoStore;
  /** Fences a loop-off route's work from hippo.db on the server thread when the store has workers. */
  offLoop: <T>(run: () => T) => T;
  publicJsonBodies: ReadonlyMap<string, string>;
  callerLimiter?: RateLimiter;
  failedAuthLimiter: RateLimiter;
};

/** Per-request values the /v1 route handlers read. */
export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  opts: ResolvedServeOpts;
  query: URLSearchParams;
}

/** A request past the dispatch gate, carrying the caller the gate authenticated. */
export interface AuthedRouteRequest<G extends StoreGroup = 'base'> extends RouteRequest {
  ctx: ContextWith<G>;
}

/** A route's store status: a `storeReady` group, a `sqliteOnly`
 * reason, or neither while it waits for a group; never both. */
type StoreStatus<S extends StoreGroup> =
  | { storeReady?: S; sqliteOnly?: never }
  | { sqliteOnly: string; storeReady?: never };

/** What the dispatch gate proves before a handler runs: any caller, an admin, a host admin on loopback, or nothing, for
 * a route whose handler checks the sender's signature itself. */
export type RouteAuth = 'caller' | 'admin' | 'host-admin-local' | 'webhook-signature';

export type RouteEndpoint<R> =
  | { path: string; handler: (r: R) => Promise<void> }
  | { pattern: string; handler: (r: R, params: Record<string, string>) => Promise<void> }
  | { regex: RegExp; handler: (r: R, match: RegExpMatchArray) => Promise<void> };

/** One /v1 route: an exact path, a matchPath pattern, or a regex, each paired with one method's handler. Under another
 * store it runs only with its store's `storeReady` group; `loop: 'off'` runs its SQLite work on a worker thread. */
export type RouteOf<G extends StoreGroup, S extends StoreGroup = G> =
  & { method: string; loop?: 'off' }
  & StoreStatus<S>
  & (
    | ({ auth: Exclude<RouteAuth, 'webhook-signature'> } & RouteEndpoint<AuthedRouteRequest<G>>)
    | ({ auth: 'webhook-signature' } & RouteEndpoint<RouteRequest>)
  );

/** A route as the table holds it, its handler's group erased: `defineRoute` is where a handler's group meets the
 * row's `storeReady`. */
export type Route = RouteOf<'base', StoreGroup>;
