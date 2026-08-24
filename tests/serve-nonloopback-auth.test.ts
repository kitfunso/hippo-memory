// tests/serve-nonloopback-auth.test.ts
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
//   3. the loopback default path is unaffected (no regression).
//
// Store-root convention follows tests/c5-cli-cutoff-counters.test.ts's
// makeEnv: the store root passed to initStore/serve IS the .hippo directory
// itself, not its parent.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { serve, type ServerHandle } from '../src/server.js';

describe('serve() non-loopback host guard', () => {
  let hippoRoot: string;
  let handle: ServerHandle | undefined;
  const savedRequireAuth = process.env.HIPPO_REQUIRE_AUTH;

  beforeEach(() => {
    hippoRoot = join(mkdtempSync(join(tmpdir(), 'hippo-nla-')), '.hippo');
    initStore(hippoRoot);
    delete process.env.HIPPO_REQUIRE_AUTH;
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
    if (savedRequireAuth === undefined) {
      delete process.env.HIPPO_REQUIRE_AUTH;
    } else {
      process.env.HIPPO_REQUIRE_AUTH = savedRequireAuth;
    }
    rmSync(hippoRoot, { recursive: true, force: true });
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

  describe('with HIPPO_REQUIRE_AUTH=1', () => {
    beforeEach(async () => {
      process.env.HIPPO_REQUIRE_AUTH = '1';
      handle = await serve({ hippoRoot, host: '0.0.0.0', port: 0 });
    });

    it('starts and binds the requested non-loopback host', () => {
      expect(handle!.port).toBeGreaterThan(0);
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
      const followUpRes = await fetch(
        `http://127.0.0.1:${handle!.port}/v1/memories?q=nonloopback-auth-marker`,
        { headers: authHeaders },
      );
      expect(followUpRes.status).toBe(200);
      const followUpBody = await followUpRes.json();
      const found = (followUpBody.results as Array<{ content: string }>).some((r) =>
        r.content.includes('nonloopback-auth-marker'),
      );
      expect(found).toBe(true);
    });
  });
});

// clientIpForRateLimit: proxy-aware rate-limit keying. Behind a
// TLS-terminating proxy every socket carries the proxy's address, so
// HIPPO_CLIENT_IP_HEADER names the header the proxy stamps with the real
// client address. Unset (the default), the socket address keys the bucket.
import { clientIpForRateLimit } from '../src/server.js';
import type { IncomingMessage } from 'node:http';

function fakeReq(headers: Record<string, string | string[]>, remoteAddress = '10.0.0.9'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('clientIpForRateLimit', () => {
  const saved = process.env.HIPPO_CLIENT_IP_HEADER;

  afterEach(() => {
    if (saved === undefined) delete process.env.HIPPO_CLIENT_IP_HEADER;
    else process.env.HIPPO_CLIENT_IP_HEADER = saved;
  });

  it('defaults to the socket remote address when the env var is unset', () => {
    delete process.env.HIPPO_CLIENT_IP_HEADER;
    expect(clientIpForRateLimit(fakeReq({ 'fly-client-ip': '203.0.113.7' }))).toBe('10.0.0.9');
  });

  it('uses the configured header when present', () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'fly-client-ip';
    expect(clientIpForRateLimit(fakeReq({ 'fly-client-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('matches the header case-insensitively (env var may be given uppercased)', () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'Fly-Client-IP';
    expect(clientIpForRateLimit(fakeReq({ 'fly-client-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('takes the first entry of a comma-joined proxy chain', () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': '203.0.113.7, 198.51.100.2' }))).toBe('203.0.113.7');
  });

  it('takes the first value of a repeated header', () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'x-forwarded-for';
    expect(clientIpForRateLimit(fakeReq({ 'x-forwarded-for': ['203.0.113.7', '198.51.100.2'] }))).toBe('203.0.113.7');
  });

  it('falls back to the socket address when the header is absent or empty', () => {
    process.env.HIPPO_CLIENT_IP_HEADER = 'fly-client-ip';
    expect(clientIpForRateLimit(fakeReq({}))).toBe('10.0.0.9');
    expect(clientIpForRateLimit(fakeReq({ 'fly-client-ip': '  ' }))).toBe('10.0.0.9');
  });
});
