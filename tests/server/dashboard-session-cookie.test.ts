// The dashboard session cookie carries Secure when its request came over TLS, and only then.
import { randomBytes } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/base/util/http-util.js';
import { DAY_MS } from '../../src/base/util/time.js';
import { passDashboardSession } from '../../src/surface/server/dashboard-session.js';

/** The Set-Cookie a page load with the right token gets over `socket`. */
function cookieOver(socket: Socket): string {
  const token = randomBytes(16).toString('hex');
  const req = new IncomingMessage(socket);
  req.headers = { host: '127.0.0.1:4100' };
  const res = new ServerResponse(req);
  try {
    expect(passDashboardSession(req, res, new URLSearchParams({ token }), { token, port: 4100 })).toBe('token');
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

  describe('expiry', () => {
    const token = randomBytes(16).toString('hex');
    const access = { token, port: 4100 };
    const issuedAt = Date.UTC(2026, 9, 21);

    /** The kind of session granted, or the error status, plus the Set-Cookie the request earned. */
    function pass(cookie: string | undefined, query: URLSearchParams, now: number) {
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

    it('takes its own cookie within a day and refuses it from the day on', () => {
      const cookie = pass(undefined, new URLSearchParams({ token }), issuedAt).set.split(';')[0] ?? '';
      const empty = new URLSearchParams();
      expect(pass(cookie, empty, issuedAt + DAY_MS - 1).kind).toBe('cookie');
      expect(pass(cookie, empty, issuedAt + DAY_MS).kind).toBe('401');
    });

    it('refuses a cookie whose issue time was changed, since the MAC covers it', () => {
      const cookie = pass(undefined, new URLSearchParams({ token }), issuedAt).set.split(';')[0] ?? '';
      const name = cookie.slice(0, cookie.indexOf('='));
      const mac = cookie.slice(cookie.indexOf('.') + 1);
      expect(pass(`${name}=${issuedAt + DAY_MS}.${mac}`, new URLSearchParams(), issuedAt + DAY_MS + 1).kind).toBe(
        '401',
      );
    });
  });
});
