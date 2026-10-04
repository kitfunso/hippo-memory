// Client IP keying and the per-IP rate limit for /v1 and /mcp.
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { log } from '../log.js';
import type { RateLimiter } from '../rate-limit.js';
import { HttpError } from '../http-util.js';

/**
 * Rate-limit key for a request. Defaults to the socket's remote address.
 *
 * Behind a TLS-terminating proxy (Fly, most PaaS ingress) every socket
 * carries the proxy's address, so per-IP buckets collapse into one global
 * bucket that unauthenticated traffic can drain before auth runs. Set
 * HIPPO_CLIENT_IP_HEADER to the header the proxy stamps with the real
 * client address (fly-client-ip on Fly, which the edge always overwrites)
 * to key buckets per client instead.
 *
 * Only set this when a trusted proxy fronts EVERY request: a directly
 * reachable server honoring the header would let clients mint a fresh
 * bucket per request and bypass the limiter entirely.
 *
 * HIPPO_TRUSTED_PROXIES (comma-separated IPs or CIDRs) pins which peers count
 * as that proxy: the header is read only when the socket peer is listed, and
 * listed hops are skipped. In a comma-joined chain (X-Forwarded-For) the key is
 * the rightmost hop no trusted proxy added; entries to its left are whatever
 * the client sent, so they never pick the bucket.
 */
export function clientIpForRateLimit(req: IncomingMessage): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  const header = process.env.HIPPO_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (!header) return socketIp;
  const trusted = trustedProxyList(process.env.HIPPO_TRUSTED_PROXIES);
  if (trusted && !isTrustedProxy(trusted, socketIp)) return socketIp;
  const raw = req.headers[header];
  const hops = (Array.isArray(raw) ? raw.join(',') : raw ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trusted || !isTrustedProxy(trusted, hops[i]!)) return hops[i]!;
  }
  return hops[0] ?? socketIp;
}

let trustedProxyCache: { raw: string; list: BlockList | undefined } | undefined;

/** Parses HIPPO_TRUSTED_PROXIES once per distinct value; undefined when unset, so any peer may set the header. */
function trustedProxyList(raw: string | undefined): BlockList | undefined {
  if (!raw?.trim()) return undefined;
  if (trustedProxyCache?.raw === raw) return trustedProxyCache.list;
  const list = new BlockList();
  for (const entry of raw.split(',').map((e) => e.trim()).filter((e) => e.length > 0)) {
    const [addr = '', prefix] = entry.split('/');
    const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    const bits = prefix === undefined ? undefined : Number(prefix);
    const maxBits = family === 'ipv6' ? 128 : 32;
    if (isIP(addr) === 0 || (bits !== undefined && (!Number.isInteger(bits) || bits < 0 || bits > maxBits))) {
      log.warn(`HIPPO_TRUSTED_PROXIES: ignoring '${entry}', not an IP address or CIDR`);
      continue;
    }
    if (bits === undefined) list.addAddress(addr, family);
    else list.addSubnet(addr, bits, family);
  }
  trustedProxyCache = { raw, list };
  return list;
}

function isTrustedProxy(list: BlockList, ip: string): boolean {
  const bare = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(bare);
  return family !== 0 && list.check(bare, family === 6 ? 'ipv6' : 'ipv4');
}

export function enforceRateLimit(req: IncomingMessage, path: string, limiter?: RateLimiter): void {
  // E3: per-IP rate limit on /v1/* and /mcp* to bound api-key-id enumeration. /health
  // (a liveness probe) and other paths are never throttled. A 429 thrown
  // here lands in the createServer catch like any other HttpError.
  //
  // Keyed on the socket's remote address by default. Behind a TLS-terminating
  // proxy every socket carries the proxy's address, collapsing the per-IP
  // buckets into one global bucket that pre-auth traffic can drain; set
  // HIPPO_CLIENT_IP_HEADER there so each real client gets its own bucket
  // (see clientIpForRateLimit).
  if (limiter && (path.startsWith('/v1/') || path === '/mcp' || path === '/mcp/stream')) {
    const ip = clientIpForRateLimit(req);
    if (!limiter.check(ip)) {
      throw new HttpError(429, 'rate limit exceeded');
    }
  }
}
