// The dashboard URL carries a one-time ticket that buys the session cookie; the cookie carries Secure when its request
// came over TLS, and only then.
import { randomBytes } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/base/errors/http-errors.js';
import { DAY_MS, MINUTE_MS } from '../../src/base/util/time.js';
import {
  dashboardTickets,
  passDashboardSession,
  type DashboardAccess,
} from '../../src/surface/server/dashboard-session.js';

const accessFor = (token: string): DashboardAccess => ({ token, port: 4100, tickets: dashboardTickets() });

/** The Set-Cookie a page load with a fresh ticket gets over `socket`. */
function cookieOver(socket: Socket): string {
  const access = accessFor(randomBytes(16).toString('hex'));
  const req = new IncomingMessage(socket);
  req.headers = { host: '127.0.0.1:4100' };
  const res = new ServerResponse(req);
  try {
    const token = access.tickets.mint(Date.now());
    expect(passDashboardSession(req, res, new URLSearchParams({ token }), access)).toBe('ticket');
    return String(res.getHeader('set-cookie'));
  } finally {
    socket.destroy();
  }
}

describe('the dashboard session cookie', () => {
  it('carries Secure over TLS', () => {
    expect(cookieOver(new TLSSocket(new Socket()))).toMatch(
      /; HttpOnly; SameSite=Strict; Path=\/; Max-Age=86400; Secure$/,
    );
  });

  it('leaves Secure off over plain HTTP, the transport the loopback listener speaks', () => {
    expect(cookieOver(new Socket())).toMatch(/; HttpOnly; SameSite=Strict; Path=\/; Max-Age=86400$/);
  });

  describe('tickets and expiry', () => {
    const token = randomBytes(16).toString('hex');
    const issuedAt = Date.UTC(2026, 9, 21);

    /** The kind of session granted, or the error status, plus the Set-Cookie the request earned. */
    function pass(access: DashboardAccess, cookie: string | undefined, query: URLSearchParams, now: number) {
      const req = new IncomingMessage(new Socket());
      req.headers = { host: '127.0.0.1:4100' };
      if (cookie !== undefined) req.headers.cookie = cookie;
      const res = new ServerResponse(req);
      try {
        const kind = passDashboardSession(req, res, query, access, () => now);
        return { kind: String(kind), set: String(res.getHeader('set-cookie')) };
      } catch (err) {
        return { kind: err instanceof HttpError ? String(err.status) : 'error', set: '' };
      } finally {
        req.socket.destroy();
      }
    }

    /** The cookie pair a fresh ticket buys at `now`. */
    function signIn(access: DashboardAccess, now: number): string {
      const ticket = new URLSearchParams({ token: access.tickets.mint(now) });
      return pass(access, undefined, ticket, now).set.split(';')[0] ?? '';
    }

    it('takes a ticket once: the second use is the 401, and the cookie it bought still works', () => {
      const access = accessFor(token);
      const ticket = new URLSearchParams({ token: access.tickets.mint(issuedAt) });
      const first = pass(access, undefined, ticket, issuedAt + 1);
      expect(first.kind).toBe('ticket');
      expect(pass(access, undefined, ticket, issuedAt + 2).kind).toBe('401');
      expect(pass(access, first.set.split(';')[0], new URLSearchParams(), issuedAt + 3).kind).toBe('cookie');
    });

    it('refuses a ticket from ten minutes after its minting on', () => {
      const access = accessFor(token);
      const late = new URLSearchParams({ token: access.tickets.mint(issuedAt) });
      expect(pass(access, undefined, late, issuedAt + 10 * MINUTE_MS).kind).toBe('401');
      const inTime = new URLSearchParams({ token: access.tickets.mint(issuedAt) });
      expect(pass(access, undefined, inTime, issuedAt + 10 * MINUTE_MS - 1).kind).toBe('ticket');
    });

    it('refuses the per-start token in the URL, so only a ticket opens the dashboard', () => {
      const access = accessFor(token);
      access.tickets.mint(issuedAt);
      expect(pass(access, undefined, new URLSearchParams({ token }), issuedAt).kind).toBe('401');
    });

    it('takes its own cookie within a day and refuses it from the day on', () => {
      const access = accessFor(token);
      const cookie = signIn(access, issuedAt);
      const empty = new URLSearchParams();
      expect(pass(access, cookie, empty, issuedAt + DAY_MS - 1).kind).toBe('cookie');
      expect(pass(access, cookie, empty, issuedAt + DAY_MS).kind).toBe('401');
    });

    it('checks a cookie against the token alone, never the ticket that bought it', () => {
      const cookie = signIn(accessFor(token), issuedAt);
      expect(pass(accessFor(token), cookie, new URLSearchParams(), issuedAt + 1).kind).toBe('cookie');
    });

    it('refuses a cookie whose issue time was changed, since the MAC covers it', () => {
      const access = accessFor(token);
      const cookie = signIn(access, issuedAt);
      const name = cookie.slice(0, cookie.indexOf('='));
      const mac = cookie.slice(cookie.indexOf('.') + 1);
      expect(
        pass(access, `${name}=${issuedAt + DAY_MS}.${mac}`, new URLSearchParams(), issuedAt + DAY_MS + 1).kind,
      ).toBe('401');
    });
  });
});
