// Which HTTP client a request comes from, so per-client state (the ids it was last shown) never mixes two callers.
import type { IncomingMessage } from 'node:http';
import type { Context } from '../api/types.js';
import { resolveClientKey } from '../api/recall/last-recalled.js';
import { blockHash } from '../util/token-text.js';
import { readAuthHeader } from './auth.js';
import { clientLimitKey } from './client-ip.js';

/** A hash of the bearer (16 hex chars, so the raw token is never logged) plus the address the rate limiter keys on;
 * 'noauth' covers loopback. MCP over HTTP and the REST routes share it, so a client's outcome finds its recall. */
export function clientKeyOf(req: IncomingMessage): string {
  const auth = readAuthHeader(req);
  const tokenHash = auth.kind === 'bearer' ? blockHash(auth.token) : 'noauth';
  return `http:${tokenHash}:${clientLimitKey(req)}`;
}

/** The key a REST recall records its shown ids under and a REST outcome with no ids reads. */
export function restClientKey(req: IncomingMessage, ctx: Pick<Context, 'tenantId'>): string {
  return resolveClientKey({ clientKey: clientKeyOf(req), tenantId: ctx.tenantId });
}
