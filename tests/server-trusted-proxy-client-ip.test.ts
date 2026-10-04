// The rate-limit key trusts a forwarded header only in proxy mode, and then takes the
// rightmost hop no trusted proxy added, so a client cannot mint a fresh bucket per request.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { initStore } from '../src/store/open.js';
import { clientIpForRateLimit, serve, type ServerHandle } from '../src/server.js';

const ENV_KEYS = ['HIPPO_CLIENT_IP_HEADER', 'HIPPO_TRUSTED_PROXIES', 'HIPPO_V1_RPS'] as const;

function fakeReq(headers: Record<string, string>, remoteAddress: string): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
  const req = new IncomingMessage(socket);
  req.headers = headers;
  return req;
}

describe('clientIpForRateLimit behind a trusted proxy', () => {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('ignores a spoofed X-Forwarded-For when no proxy mode is configured', () => {
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': '6.6.6.6' }, '10.0.0.9'))).toBe('10.0.0.9');
  });

  it('takes the rightmost hop, which the fronting proxy appended, not the client-supplied first hop', () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
    const req = fakeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, '10.0.0.9');
    expect(clientIpForRateLimit(req)).toBe('203.0.113.7');
  });

  it('skips trusted proxy hops when walking the chain from the right', () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
    process.env.HIPPO_TRUSTED_PROXIES = '10.0.0.9, 10.1.0.0/16';
    const req = fakeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.1.4.2' }, '10.0.0.9');
    expect(clientIpForRateLimit(req)).toBe('203.0.113.7');
  });

  it('ignores the header when the socket peer is not a listed trusted proxy', () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
    process.env.HIPPO_TRUSTED_PROXIES = '10.0.0.1';
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': '6.6.6.6' }, '10.0.0.9'))).toBe('10.0.0.9');
  });

  it('matches an IPv4-mapped IPv6 peer against an IPv4 trusted proxy entry', () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
    process.env.HIPPO_TRUSTED_PROXIES = '10.0.0.9';
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': '203.0.113.7' }, '::ffff:10.0.0.9'))).toBe('203.0.113.7');
  });

  it('takes the leftmost hop when every hop is a trusted proxy', () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
    process.env.HIPPO_TRUSTED_PROXIES = '10.0.0.0/8';
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': '10.0.0.3, 10.0.0.4' }, '10.0.0.9'))).toBe('10.0.0.3');
  });
});

describe('rate limiting over real HTTP with rotating spoofed X-Forwarded-For', () => {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  let root: string;
  let handle: ServerHandle | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-trusted-proxy-'));
    initStore(root);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.HIPPO_V1_RPS = '1';
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = undefined;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function statusesWithRotatingXff(): Promise<number[]> {
    handle = await serve({ hippoRoot: root, port: 0 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${handle.url}/v1/memories?q=x`, { headers: { 'x-forwarded-for': `198.51.100.${i + 1}` } });
      statuses.push(res.status);
    }
    return statuses;
  }

  it('shares one bucket when the header is not configured', async () => {
    expect(await statusesWithRotatingXff()).toContain(429);
  });

  it('shares one bucket when the socket peer is not a listed trusted proxy', async () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
    process.env.HIPPO_TRUSTED_PROXIES = '192.0.2.1';
    expect(await statusesWithRotatingXff()).toContain(429);
  });
});
