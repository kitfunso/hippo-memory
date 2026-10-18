// The rate-limit key trusts a forwarded header only from a listed proxy peer and then takes
// the rightmost hop no trusted proxy added, so a client cannot mint a fresh bucket per request.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { clientIpForRateLimit, serve, type ServerHandle } from '../../src/server.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/auth.js';
import { lastRecalledIds } from '../../src/api/recall/last-recalled.js';
import { makeRoot } from '../_helpers/make-root.js';

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

describe('the MCP client key, which scopes the last recall per client, behind a proxy', () => {
  let root: string;
  let handle: ServerHandle | undefined;
  let token: string;

  beforeEach(() => {
    root = makeRoot('mcp-client-key');
    for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
    vi.stubEnv('HIPPO_V1_RPS', '0');
    const db = openHippoDb(root);
    try {
      token = createApiKey(db, { tenantId: 'default', label: 'mcp-client-key', role: 'admin' }).plaintext;
    } finally {
      closeHippoDb(db);
    }
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = undefined;
  });

  async function newRecallKeys(): Promise<string[]> {
    handle = await serve({ hippoRoot: root, port: 0 });
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.7',
    };
    const remembered = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'proxy canary memory' }),
    });
    expect(remembered.status).toBe(200);
    const before = new Set(lastRecalledIds.keys());
    const call = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'hippo_recall', arguments: { query: 'proxy canary' } },
    };
    const res = await fetch(`${handle.url}/mcp`, { method: 'POST', headers, body: JSON.stringify(call) });
    expect(res.status).toBe(200);
    return [...lastRecalledIds.keys()].filter((key) => !before.has(key));
  }

  it('keys on the forwarded client address, as the rate limiter does, when the peer is a listed trusted proxy', async () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '127.0.0.1');
    expect(await newRecallKeys()).toEqual([expect.stringMatching(/^http:[0-9a-f]+:203\.0\.113\.7$/)]);
  });

  it('ignores the forwarded header when the peer is not a listed trusted proxy', async () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '192.0.2.1');
    expect(await newRecallKeys()).toEqual([expect.stringMatching(/^http:[0-9a-f]+:127\.0\.0\.1$/)]);
  });
});

describe('rate limiting over real HTTP with rotating spoofed X-Forwarded-For', () => {
  let root: string;
  let handle: ServerHandle | undefined;

  beforeEach(() => {
    root = makeRoot('trusted-proxy');
    for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
    vi.stubEnv('HIPPO_V1_RPS', '1');
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = undefined;
  });

  async function statusesWithRotatingXff(): Promise<number[]> {
    handle = await serve({ hippoRoot: root, port: 0 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${handle.url}/v1/memories?q=x`, {
        headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
      });
      statuses.push(res.status);
    }
    return statuses;
  }

  it('shares one bucket when the header is not configured', async () => {
    expect(await statusesWithRotatingXff()).toContain(429);
  });

  it('shares one bucket when the socket peer is not a listed trusted proxy', async () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '192.0.2.1');
    expect(await statusesWithRotatingXff()).toContain(429);
  });

  it('gives each forwarded address its own bucket when the socket peer is a listed proxy', async () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '127.0.0.1,::1');
    expect(await statusesWithRotatingXff()).not.toContain(429);
  });

  it('refuses to start with the header set and no trusted proxy listed', async () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    await expect(serve({ hippoRoot: root, port: 0 })).rejects.toMatchObject({
      name: 'UntrustedClientIpHeaderError',
      message: expect.stringMatching(
        /HIPPO_CLIENT_IP_HEADER is x-forwarded-for but HIPPO_TRUSTED_PROXIES is unset.*addresses or CIDRs/,
      ),
    });
  });

  it('refuses to start when HIPPO_TRUSTED_PROXIES lists *, with or without the header, and boots with a list', async () => {
    for (const header of [undefined, 'x-forwarded-for']) {
      if (header) vi.stubEnv('HIPPO_CLIENT_IP_HEADER', header);
      vi.stubEnv('HIPPO_TRUSTED_PROXIES', '192.0.2.1, *');
      await expect(serve({ hippoRoot: root, port: 0 })).rejects.toMatchObject({
        name: 'WildcardTrustedProxiesError',
        message: expect.stringMatching(/must list the proxy's addresses or CIDRs, not \*/),
      });
    }
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '192.0.2.1');
    await (await serve({ hippoRoot: root, port: 0 })).stop();
  });
});
