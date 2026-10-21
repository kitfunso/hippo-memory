// The 'dashboard-session' auth kind: the per-start token, then a session cookie that only dashboard rows read, so a
// cookie never reaches a /v1 route.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import { HttpError } from '../../base/util/http-util.js';
import { DAY_MS } from '../../base/util/time.js';
import { isForeignPage } from './auth.js';

/** The secret a dashboard started with, and the port it asked for, which names the cookie until the socket says. */
export interface DashboardAccess {
  readonly token: string;
  readonly port: number;
}

/** How the request proved itself: the token in its URL, which the page route then moves it off, or the cookie. */
export type DashboardSession = 'token' | 'cookie';

const UNAUTHORIZED =
  'Unauthorized: open the dashboard with the URL `hippo dashboard` printed; it carries the access token.';

// The server refuses a cookie older than this too, since a browser that restores its session ignores Max-Age.
const COOKIE_MAX_AGE_S = DAY_MS / 1000;

function sameSecret(given: string | undefined, secret: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The session cookie's value: the issue time and a MAC of it with the token, so a read of the browser's cookie store
 * never yields the token and the server can age the cookie out. */
function sessionValue(token: string, port: number, issuedAtMs: number): string {
  const mac = createHmac('sha256', token).update(`hippo-dashboard-session:${port}:${issuedAtMs}`).digest('hex');
  return `${issuedAtMs}.${mac}`;
}

/** Whether `given` is a cookie this token issued for this port, within the cookie's Max-Age. */
function liveSession(given: string | undefined, token: string, port: number, nowMs: number): boolean {
  const issuedAtMs = Number(given?.split('.', 1)[0]);
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs > nowMs || nowMs - issuedAtMs >= COOKIE_MAX_AGE_S * 1000) {
    return false;
  }
  return sameSecret(given, sessionValue(token, port, issuedAtMs));
}

/** The dashboard gate: refuses a foreign page (403) before any secret is read, then takes the token, setting the
 * cookie, or the cookie; anything else is a 401. */
export function passDashboardSession(
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  access: DashboardAccess,
  now: () => number = Date.now,
): DashboardSession {
  if (isForeignPage(req)) throw new HttpError(403, 'cross-site or non-local request refused');
  const port = req.socket.localPort ?? access.port;
  // Cookies ignore the port, so the name carries it: two dashboards on one host keep separate sessions.
  const cookieName = `hippo_dashboard_${port}`;
  if (sameSecret(query.get('token') ?? undefined, access.token)) {
    // A session minted over TLS must never travel over plain HTTP; the plain loopback listener cannot promise Secure.
    const secure = req.socket instanceof TLSSocket ? '; Secure' : '';
    const value = sessionValue(access.token, port, now());
    res.setHeader(
      'Set-Cookie',
      `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secure}`,
    );
    return 'token';
  }
  if (liveSession(cookieValue(req.headers.cookie, cookieName), access.token, port, now())) return 'cookie';
  throw new HttpError(401, UNAUTHORIZED);
}
