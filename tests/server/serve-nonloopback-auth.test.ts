// tests/server/serve-nonloopback-auth.test.ts
//
// serve()'s non-loopback guard used to refuse EVERY non-loopback host
// unconditionally, citing the A5 v2 auth middleware as "not yet built".
// That middleware (buildContextWithAuth / requireAuth in src/server.ts) has
// since shipped: every route except GET /health goes through it. This suite
// asserts the updated guard:
//   1. still refuses a non-loopback bind by default (no auth = no bind),
//   2. allows a non-loopback bind when HIPPO_REQUIRE_AUTH=1, and once bound,
//      every route behaves exactly as the Bearer-lockdown regime promises
//      (public /health, 401 without a token, 200 with a valid one, and the
//      created row is actually retrievable through the authed path),
//   3. the loopback default path is unaffected (no regression),
//   4. a non-loopback bind with no TLS refuses unless cleartext is allowed.
//
// Store-root convention follows tests/cli/cli-recall-cutoff-counters.test.ts's
// makeEnv: the store root passed to initStore/serve IS the .hippo directory
// itself, not its parent.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/auth.js';
import { log } from '../../src/util/log.js';
import { serve, clientIpForRateLimit, type ServerHandle } from '../../src/server.js';
import type { IncomingMessage } from 'node:http';
import { makeStore } from '../_helpers/make-root.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('serve() non-loopback host guard', () => {
  let hippoRoot: string;
  let handle: ServerHandle | undefined;

  beforeEach(() => {
    hippoRoot = makeStore('nla').root;
    vi.stubEnv('HIPPO_REQUIRE_AUTH', undefined);
    vi.stubEnv('HIPPO_ALLOW_CLEARTEXT', undefined);
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
  });

  it('rejects a non-loopback bind without HIPPO_REQUIRE_AUTH', async () => {
    await expect(serve({ hippoRoot, host: '0.0.0.0', port: 0 })).rejects.toThrow(
      /Set HIPPO_REQUIRE_AUTH=1 to bind non-loopback/,
    );
  });

  it('loopback bind still works without HIPPO_REQUIRE_AUTH (no regression)', async () => {
    handle = await serve({ hippoRoot, host: '127.0.0.1', port: 0 });
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
  });

  it('refuses a network bind without TLS by default, naming every way to allow it', async () => {
    vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
    await expect(serve({ hippoRoot, host: '0.0.0.0', port: 0 })).rejects.toMatchObject({
      name: 'CleartextBindError',
      message: expect.stringMatching(
        /0\.0\.0\.0.*--tls-cert.*--allow-cleartext.*HIPPO_ALLOW_CLEARTEXT=1.*allowCleartext: true/s,
      ),
    });
  });

  it('starts a network bind without TLS once HIPPO_ALLOW_CLEARTEXT=1', async () => {
    vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
    vi.stubEnv('HIPPO_ALLOW_CLEARTEXT', '1');
    handle = await serve({ hippoRoot, host: '0.0.0.0', port: 0 });
    // Port 0 lets the OS pick a free port, so only its range is fixed.
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.port).toBeLessThanOrEqual(65535);
  });

  it('warns once at start that an allowed network bind without TLS is cleartext, and stays quiet on loopback', async () => {
    vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
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

  describe('with HIPPO_REQUIRE_AUTH=1', () => {
    beforeEach(async () => {
      vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
      handle = await serve({ hippoRoot, host: '0.0.0.0', port: 0, allowCleartext: true });
    });

    it('starts and binds the requested non-loopback host', () => {
      // Port 0 lets the OS pick a free port, so only its range is fixed.
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

    it('mints a key, authorized GET /v1/memories: 200, and a POST + follow-up search finds the row', async () => {
      const db = openHippoDb(hippoRoot);
      let plaintext: string;
      try {
        ({ plaintext } = createApiKey(db, { tenantId: 'default', label: 'nla-test' }));
      } finally {
        closeHippoDb(db);
      }

      const authHeaders = { authorization: `Bearer ${plaintext}` };

      // 401 -> 200 with a valid bearer token on the read route.
      const searchRes = await fetch(`http://127.0.0.1:${handle!.port}/v1/memories?q=x`, {
        headers: authHeaders,
      });
      expect(searchRes.status).toBe(200);

      // POST /v1/memories with the bearer succeeds.
      const postRes = await fetch(`http://127.0.0.1:${handle!.port}/v1/memories`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'nonloopback-auth-marker unique content for search' }),
      });
      expect(postRes.status).toBeGreaterThanOrEqual(200);
      expect(postRes.status).toBeLessThan(300);

      // A follow-up authorized search finds the newly created row.
      const followUpRes = await fetch(`http://127.0.0.1:${handle!.port}/v1/memories?q=nonloopback-auth-marker`, {
        headers: authHeaders,
      });
      expect(followUpRes.status).toBe(200);
      const followUpBody: { results: Array<{ content: string }> } = await followUpRes.json();
      const found = followUpBody.results.some((r) => r.content.includes('nonloopback-auth-marker'));
      expect(found).toBe(true);
    });
  });
});

// clientIpForRateLimit: proxy-aware rate-limit keying. Behind a
// TLS-terminating proxy every socket carries the proxy's address, so
// HIPPO_CLIENT_IP_HEADER names the header the proxy stamps with the real
// client address. Unset (the default), the socket address keys the bucket.
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
