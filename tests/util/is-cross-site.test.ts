import { describe, expect, it } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { isCrossSite } from '../../src/base/util/http-util.js';

const req = (headers: Record<string, string>): IncomingMessage =>
  Object.assign(new IncomingMessage(new Socket()), { headers });

/** isCrossSite for a request that came in on an https listener. */
function overTls(headers: Record<string, string>): boolean {
  const socket = new TLSSocket(new Socket());
  try {
    return isCrossSite(Object.assign(new IncomingMessage(socket), { headers }));
  } finally {
    socket.destroy();
  }
}

describe('isCrossSite', () => {
  it('accepts an Origin on the same host and port under the listener scheme', () => {
    expect(isCrossSite(req({ host: 'hippo.local:3000', origin: 'http://hippo.local:3000' }))).toBe(false);
    expect(overTls({ host: 'hippo.local:3000', origin: 'https://hippo.local:3000' })).toBe(false);
  });

  it('refuses an Origin on the same host and port under the other scheme', () => {
    expect(overTls({ host: 'hippo.local:3000', origin: 'http://hippo.local:3000' })).toBe(true);
    expect(isCrossSite(req({ host: 'hippo.local:3000', origin: 'https://hippo.local:3000' }))).toBe(true);
  });

  it('refuses another host or port under either scheme, and an opaque origin', () => {
    expect(isCrossSite(req({ host: 'hippo.local:3000', origin: 'https://evil.example' }))).toBe(true);
    expect(isCrossSite(req({ host: 'hippo.local:3000', origin: 'http://hippo.local:4000' }))).toBe(true);
    expect(isCrossSite(req({ host: 'hippo.local:3000', origin: 'null' }))).toBe(true);
  });

  it('refuses Sec-Fetch-Site cross-site even with a matching https Origin', () => {
    expect(overTls({ host: 'h:1', origin: 'https://h:1', 'sec-fetch-site': 'cross-site' })).toBe(true);
  });
});
