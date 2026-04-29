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

  const v1Routes: ReadonlyArray<{ method: string; path: string; body?: string }> = [
    { method: 'POST', path: '/v1/memories', body: '{"content":"x"}' },
    { method: 'GET', path: '/v1/memories?q=x' },
    { method: 'POST', path: '/v1/auth/keys', body: '{}' },
    { method: 'GET', path: '/v1/auth/keys' },
    { method: 'GET', path: '/v1/audit' },
  ];

  it('all /v1/* routes except slack require Bearer', async () => {
    for (const r of v1Routes) {
      const res = await fetch(`http://127.0.0.1:${handle.port}${r.path}`, {
        method: r.method,
        headers: { 'content-type': 'application/json' },
        body: r.body,
      });
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    }
  });
});
