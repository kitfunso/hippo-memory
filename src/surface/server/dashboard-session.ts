import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import { HttpError } from '../../base/errors/http-errors.js';
import { DAY_MS, MINUTE_MS } from '../../base/util/time.js';
import { isForeignPage } from './auth.js';

/** The secret a dashboard started with, which keys its cookies and never leaves the server, the
 * port it asked for, which names the cookie until the socket says, and the tickets it handed
 * out. */
export interface DashboardAccess {
  readonly token: string;
  readonly port: number;
  readonly tickets: DashboardTickets;
}

/** How the request proved itself: a ticket in its URL, which the page route then moves it off,
 * or the cookie. */
export type DashboardSession = 'ticket' | 'cookie';

/** The one-time tickets a dashboard URL carries in place of the per-start token. */
export interface DashboardTickets {
  mint(nowMs: number): string;
  redeem(given: string | undefined, nowMs: number): boolean;
}

const UNAUTHORIZED =
  'Unauthorized: open the dashboard with the URL `hippo dashboard` printed; it carries the access token.';

// The server refuses a cookie older than this too, since a browser that restores its session
// ignores Max-Age.
const COOKIE_MAX_AGE_S = DAY_MS / 1000;

const TICKET_TTL_MS = 10 * MINUTE_MS;

function sameSecret(given: string | undefined, secret: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Tickets held in memory with their mint times; a late one is dropped at the next mint or
 * redeem. */
export function dashboardTickets(): DashboardTickets {
  const minted = new Map<string, number>();
  const dropLate = (nowMs: number): void => {
    for (const [ticket, at] of minted) if (nowMs - at >= TICKET_TTL_MS) minted.delete(ticket);
  };
  return {
    mint(nowMs) {
      dropLate(nowMs);
      const ticket = randomBytes(32).toString('base64url');
      minted.set(ticket, nowMs);
      return ticket;
    },
    redeem(given, nowMs) {
      dropLate(nowMs);
      for (const ticket of minted.keys()) {
        if (sameSecret(given, ticket)) return minted.delete(ticket);
      }
      return false;
    },
  };
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function sessionValue(token: string, port: number, issuedAtMs: number): string {
  const mac = createHmac('sha256', token)
    .update(`hippo-dashboard-session:${port}:${issuedAtMs}`)
    .digest('hex');
  return `${issuedAtMs}.${mac}`;
}

function liveSession(
  given: string | undefined,
  token: string,
  port: number,
  nowMs: number,
): boolean {
  const issuedAtMs = Number(given?.split('.', 1)[0]);
  if (
    !Number.isSafeInteger(issuedAtMs) ||
    issuedAtMs > nowMs ||
    nowMs - issuedAtMs >= COOKIE_MAX_AGE_S * 1000
  ) {
    return false;
  }
  return sameSecret(given, sessionValue(token, port, issuedAtMs));
}

export interface PassDashboardSessionOptions {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly query: URLSearchParams;
  readonly access: DashboardAccess;
  readonly now?: () => number;
}

/** The dashboard gate: refuses a foreign page (403) before any secret is read, then takes a
 * ticket, setting the cookie, or the cookie; anything else is a 401. */
export function passDashboardSession({
  req,
  res,
  query,
  access,
  now = Date.now,
}: PassDashboardSessionOptions): DashboardSession {
  if (isForeignPage(req)) throw new HttpError(403, 'cross-site or non-local request refused');
  const port = req.socket.localPort ?? access.port;
  // Cookies ignore the port, so the name carries it: two dashboards on one host keep separate
  // sessions.
  const cookieName = `hippo_dashboard_${port}`;
  if (access.tickets.redeem(query.get('token') ?? undefined, now())) {
    const secure = req.socket instanceof TLSSocket ? '; Secure' : '';
    const value = sessionValue(access.token, port, now());
    res.setHeader(
      'Set-Cookie',
      `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secure}`,
    );
    return 'ticket';
  }
  if (liveSession(cookieValue(req.headers.cookie, cookieName), access.token, port, now())) {
    return 'cookie';
  }
  throw new HttpError(401, UNAUTHORIZED);
}
