// Public option and handle types for serve(), plus the /v1 route shape.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HippoStore } from '../store-port.js';

export interface ServerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
  /** Introspection-only: the underlying node:http Server, exposed so
   *  tests can assert keep-alive/headers timeout hardening without reaching
   *  into serve()'s closure. Additive field — do not depend on it for control
   *  flow outside tests. */
  server?: import('node:http').Server;
}

/** Identity an {@link AuthResolver} vouches for. The core sanitises it before use. */
export interface ResolvedBearer {
  tenantId: string;
  subject: string;
  /** Not 'admin' means 'member'. Admin is tenant-only, yet can mint member API keys (POST /v1/auth/keys); an add-on revokes them through the exported authRevoke when the IdP deprovisions the minter. */
  role: 'admin' | 'member';
  scopes?: readonly string[];
}

/** Sole judge of non-`hk_` bearer tokens: null is a 401; a throw or missed deadline is a 503, so throw only when upstream is down. */
export type AuthResolver = (token: string) => ResolvedBearer | null | Promise<ResolvedBearer | null>;

export interface ServeOpts {
  hippoRoot: string;
  /** Runs on every request and SSE heartbeat, so keep it cache-backed; API keys never reach it. */
  authResolver?: AuthResolver;
  /** Deadline for one authResolver call; defaults to 5000 ms. */
  authResolverTimeoutMs?: number;
  port?: number;
  host?: string;
  /** Stop and exit on SIGINT/SIGTERM. Only `hippo serve` owns the process, so only it sets this. */
  handleSignals?: boolean;
  /** How long stop() lets in-flight requests finish before closing their sockets; defaults to 5000 ms. */
  shutdownDrainMs?: number;
  /** Defaults to hippo.db under `hippoRoot`. A store of another kind runs only the routes ported to it; its caller closes it. */
  store?: HippoStore;
  autoSleep?: false;
}

export type ResolvedServeOpts = ServeOpts & { store: HippoStore };

/** Per-request values the /v1 route handlers read. */
export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  opts: ResolvedServeOpts;
  query: URLSearchParams;
}

/** One /v1 route: an exact path, a matchPath pattern, or a regex, each paired with the handler for one method. `storeReady` routes run under any store. */
export type Route = { method: string; storeReady?: true } & (
  | { path: string; handler: (r: RouteRequest) => Promise<void> }
  | { pattern: string; handler: (r: RouteRequest, params: Record<string, string>) => Promise<void> }
  | { regex: RegExp; handler: (r: RouteRequest, match: RegExpMatchArray) => Promise<void> }
);
