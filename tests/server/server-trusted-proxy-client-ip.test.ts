// The rate-limit key trusts a forwarded header only from a listed proxy peer and then takes
// the rightmost hop no trusted proxy added, so a client cannot mint a fresh bucket per request.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { clientIpForRateLimit } from '../../src/server.js';
import { clientKeyOf } from '../../src/surface/server/client-key.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const ENV_KEYS = ['HIPPO_CLIENT_IP_HEADER', 'HIPPO_TRUSTED_PROXIES', 'HIPPO_V1_RPS'] as const;

function fakeReq(headers: Record<string, string>, remoteAddress: string): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
  const req = new IncomingMessage(socket);
  req.headers = headers;
  return req;
}

describe('clientIpForRateLimit behind a trusted proxy', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
  });

  it('ignores a spoofed X-Forwarded-For when no proxy mode is configured', () => {
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': '6.6.6.6' }, '10.0.0.9'))).toBe('10.0.0.9');
  });

  it('ignores the header from every peer when the header is set but no trusted proxy is listed', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, '10.0.0.9'))).toBe('10.0.0.9');
  });

  it('with a CIDR listing the peer takes the rightmost hop, which the fronting proxy appended, not the client-supplied first hop', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '10.0.0.0/24');
    const req = fakeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, '10.0.0.9');
    expect(clientIpForRateLimit(req)).toBe('203.0.113.7');
  });

  it('honours the header from a listed peer', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '10.0.0.9');
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, '10.0.0.9'))).toBe(
      '203.0.113.7',
    );
  });

  it('skips trusted proxy hops when walking the chain from the right', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '10.0.0.9, 10.1.0.0/16');
    const req = fakeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.1.4.2' }, '10.0.0.9');
    expect(clientIpForRateLimit(req)).toBe('203.0.113.7');
  });

  it('ignores the header when the socket peer is not a listed trusted proxy', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '10.0.0.1');
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': '6.6.6.6' }, '10.0.0.9'))).toBe('10.0.0.9');
  });

  it('matches an IPv4-mapped IPv6 peer against an IPv4 trusted proxy entry', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '10.0.0.9');
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': '203.0.113.7' }, '::ffff:10.0.0.9'))).toBe('203.0.113.7');
  });

  it('takes the leftmost hop when every hop is a trusted proxy', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '10.0.0.0/8');
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': '10.0.0.3, 10.0.0.4' }, '10.0.0.9'))).toBe('10.0.0.3');
  });
});

describe("the client key, which scopes each client's last shown ids, behind a proxy", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
  });

  const proxied = () =>
    fakeReq({ authorization: 'Bearer hk_client_key_test', 'x-forwarded-for': '203.0.113.7' }, '127.0.0.1');

  it('keys on the forwarded client address, as the rate limiter does, when the peer is a listed trusted proxy', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '127.0.0.1');
    expect(clientKeyOf(proxied())).toMatch(/^http:[0-9a-f]+:203\.0\.113\.7$/);
  });

  it('ignores the forwarded header when the peer is not a listed trusted proxy', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '192.0.2.1');
    expect(clientKeyOf(proxied())).toMatch(/^http:[0-9a-f]+:127\.0\.0\.1$/);
  });
});
