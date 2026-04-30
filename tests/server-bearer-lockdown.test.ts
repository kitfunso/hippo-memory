import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';

/**
 * Review patch #2 regression bar: when the loopback no-auth fallback is
 * disabled (HIPPO_REQUIRE_AUTH=1), every /v1/* route MUST return 401 without
 * a Bearer token. The Slack webhook route is the only documented exception
 * (covered by tests/slack-webhook-route.test.ts). A future change that drops
 * the Bearer gate by accident — e.g. by reordering middleware or by adding
 * a second public route — should fail this test.
 */
describe('server Bearer lockdown', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-lockdown-'));
    initStore(root);
    process.env.HIPPO_REQUIRE_AUTH = '1';
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    delete process.env.HIPPO_REQUIRE_AUTH;
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  // v0.39 commit 5: route-parity expansion — every authed route in
  // src/server.ts is parameterized here. /v1/connectors/slack/events is
  // public-by-design (HMAC-verified) and covered by Slack tests; /health
  // is public and needs no test. 12 authed routes total.
  const authedRoutes: ReadonlyArray<{ method: string; path: string; body?: string }> = [
    { method: 'POST', path: '/v1/memories', body: '{"content":"x"}' },
    { method: 'GET', path: '/v1/memories?q=test' },
    { method: 'POST', path: '/v1/memories/abc/archive', body: '{"reason":"x"}' },
    { method: 'POST', path: '/v1/memories/abc/supersede', body: '{"content":"y"}' },
    { method: 'POST', path: '/v1/memories/abc/promote' },
    { method: 'DELETE', path: '/v1/memories/abc' },
    { method: 'POST', path: '/v1/auth/keys', body: '{"label":"x"}' },
    { method: 'GET', path: '/v1/auth/keys' },
    { method: 'DELETE', path: '/v1/auth/keys/hk_xyz' },
    { method: 'GET', path: '/v1/audit' },
    { method: 'POST', path: '/mcp', body: '{"jsonrpc":"2.0","method":"tools/list","id":1}' },
    { method: 'GET', path: '/mcp/stream' },
  ];

  it.each(authedRoutes)(
    'requires Bearer: $method $path (missing header)',
    async (r) => {
      const init: RequestInit = {
        method: r.method,
        headers: { 'content-type': 'application/json' },
      };
      if (r.body !== undefined) init.body = r.body;
      const res = await fetch(`http://127.0.0.1:${handle.port}${r.path}`, init);
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    },
  );

  it.each(authedRoutes)(
    'requires Bearer: $method $path (bad token)',
    async (r) => {
      const init: RequestInit = {
        method: r.method,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer hk_invalid.deadbeef',
        },
      };
      if (r.body !== undefined) init.body = r.body;
      const res = await fetch(`http://127.0.0.1:${handle.port}${r.path}`, init);
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    },
  );
});
