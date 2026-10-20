// The dashboard session cookie carries Secure when its request came over TLS, and only then.
import { randomBytes } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { describe, expect, it } from 'vitest';
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
});
