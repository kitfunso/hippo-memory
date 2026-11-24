import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/keys/auth.js';
import { log } from '../../src/base/util/log.js';
import { clientIpForRateLimit, type ServerHandle } from '../../src/server.js';
import type { IncomingMessage } from 'node:http';
import { makeStore } from '../_helpers/make-root.js';
import { needsHippoDb, serve } from '../_helpers/store-switch.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('serve() non-loopback host guard', () => {
  let hippoRoot: string;
  let handle: ServerHandle | undefined;

  beforeEach(() => {
    hippoRoot = makeStore('nla').root;
    vi.stubEnv('HIPPO_ALLOW_CLEARTEXT', undefined);
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
  });

  it('binds loopback', async () => {
    handle = await serve({ hippoRoot, host: '127.0.0.1', port: 0 });
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
  });

  it('refuses a network bind without TLS by default, naming every way to allow it', async () => {
    await expect(serve({ hippoRoot, host: '0.0.0.0', port: 0 })).rejects.toMatchObject({
      name: 'CleartextBindError',
      message: expect.stringMatching(
        /0\.0\.0\.0.*--tls-cert.*--allow-cleartext.*HIPPO_ALLOW_CLEARTEXT=1.*allowCleartext: true/s,
      ),
    });
  });

  it('starts a network bind without TLS once HIPPO_ALLOW_CLEARTEXT=1', async () => {
    vi.stubEnv('HIPPO_ALLOW_CLEARTEXT', '1');
    handle = await serve({ hippoRoot, host: '0.0.0.0', port: 0 });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.port).toBeLessThanOrEqual(65535);
  });

  it('warns once at start that an allowed network bind without TLS is cleartext, and stays quiet on loopback', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      handle = await serve({ hippoRoot, host: '0.0.0.0', port: 0, allowCleartext: true });
      await handle.stop();
      handle = await serve({ hippoRoot, host: '127.0.0.1', port: 0 });
      expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('cleartext'))).toEqual([
        expect.stringMatching(
          /listening on 0\.0\.0\.0 without TLS, as allowed.*cleartext until the proxy in front adds TLS/,
        ),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  describe('on a network bind', () => {
    beforeEach(async () => {
      handle = await serve({ hippoRoot, host: '0.0.0.0', port: 0, allowCleartext: true });
    });

    it('starts and binds the requested non-loopback host', () => {
      expect(handle!.port).toBeGreaterThan(0);
      expect(handle!.port).toBeLessThanOrEqual(65535);
    });

    it('GET /health is public: 200 with no auth', async () => {
      const res = await fetch(`http://127.0.0.1:${handle!.port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('GET /v1/memories with no Authorization: 401', async () => {
      const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/memories?q=x`);
      expect(res.status).toBe(401);
    });

    it.skipIf(needsHippoDb('db'))(
      'mints a key, authorized GET /v1/memories: 200, and a POST + follow-up search finds the row',
      async () => {
        const db = openHippoDb(hippoRoot);
        let plaintext: string;
        try {
          ({ plaintext } = createApiKey(db, { tenantId: 'default', label: 'nla-test' }));
        } finally {
          closeHippoDb(db);
        }

        const authHeaders = { authorization: `Bearer ${plaintext}` };

        const searchRes = await fetch(`http://127.0.0.1:${handle!.port}/v1/memories?q=x`, {
          headers: authHeaders,
        });
        expect(searchRes.status).toBe(200);

        const postRes = await fetch(`http://127.0.0.1:${handle!.port}/v1/memories`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'nonloopback-auth-marker unique content for search' }),
        });
        expect(postRes.status).toBeGreaterThanOrEqual(200);
        expect(postRes.status).toBeLessThan(300);

        const followUpRes = await fetch(`http://127.0.0.1:${handle!.port}/v1/memories?q=nonloopback-auth-marker`, {
          headers: authHeaders,
        });
        expect(followUpRes.status).toBe(200);
        const followUpBody: { results: Array<{ content: string }> } = await followUpRes.json();
        const found = followUpBody.results.some((r) => r.content.includes('nonloopback-auth-marker'));
        expect(found).toBe(true);
      },
    );
  });
});

function fakeReq(headers: Record<string, string | string[]>, remoteAddress = '10.0.0.9'): IncomingMessage {
  // SAFETY: clientIpForRateLimit reads only headers and socket.remoteAddress (src/server.ts), the two fields set here.
  return { headers, socket: { remoteAddress } } as IncomingMessage;
}

describe('clientIpForRateLimit from a peer HIPPO_TRUSTED_PROXIES lists', () => {
  beforeEach(() => {
    vi.stubEnv('HIPPO_TRUSTED_PROXIES', '10.0.0.0/24');
  });

  it('matches the header case-insensitively (env var may be given uppercased)', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'Fly-Client-IP');
    expect(clientIpForRateLimit(fakeReq({ 'fly-client-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('reads a repeated header as one chain and takes its rightmost entry', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'x-forwarded-for');
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': ['203.0.113.7', '198.51.100.2'] }))).toBe('198.51.100.2');
  });

  it('falls back to the socket address when the header is absent or empty', () => {
    vi.stubEnv('HIPPO_CLIENT_IP_HEADER', 'fly-client-ip');
    expect(clientIpForRateLimit(fakeReq({}))).toBe('10.0.0.9');
    expect(clientIpForRateLimit(fakeReq({ 'fly-client-ip': '  ' }))).toBe('10.0.0.9');
  });
});
