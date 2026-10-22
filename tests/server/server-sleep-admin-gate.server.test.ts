/**
 * Runtime test for v1.12.0 A5 v2 sub-1: admin-role gate on POST /v1/sleep.
 *
 * The keyless loopback caller is always a member, and member-role Bearer tokens are
 * 403'd at the route boundary BEFORE any host-wide consolidation runs.
 *
 * Member keys are constructed via direct DB insert per brainstorm decision #3
 * (no `hippo auth create-key --role` CLI flag in this episode).
 *
 * Real HTTP server (serve port:0), per-test isolated local + global stores.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import type { ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { needsHippoDb, serve } from '../_helpers/store-switch.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

describe('POST /v1/sleep admin-role gate', () => {
  let home: string;
  let globalHome: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('sleep-gate');
    globalHome = makeRoot('sleep-gate');
    vi.stubEnv('HIPPO_HOME', globalHome);
    vi.stubEnv('HIPPO_KEYLESS_LOCAL_ROLE', undefined);
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const keyless = (path: string, method = 'POST'): Promise<Response> =>
    fetch(
      `${handle.url}${path}`,
      method === 'GET'
        ? { method }
        : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dry_run: true }) },
    );

  it.skipIf(needsHippoDb('sleep'))(
    'loopback no-Bearer is a member: 403 on sleep and the quarantine routes, 200 on a member route',
    async () => {
      expect(process.env.HIPPO_KEYLESS_LOCAL_ROLE).toBeUndefined();
      expect((await keyless('/v1/sleep')).status).toBe(403);
      expect((await keyless('/v1/quarantine', 'GET')).status).toBe(403);
      expect((await keyless('/v1/quarantine/mem_missing/approve')).status).toBe(403);
      expect((await keyless('/v1/quarantine/mem_missing/reject')).status).toBe(403);
      expect((await keyless('/v1/memories?q=deploy', 'GET')).status).toBe(200);
    },
  );

  it.skipIf(needsHippoDb('sleep'))(
    'loopback no-Bearer stays a member when HIPPO_KEYLESS_LOCAL_ROLE=admin is set, which nothing reads any more',
    async () => {
      vi.stubEnv('HIPPO_KEYLESS_LOCAL_ROLE', 'admin');
      expect((await keyless('/v1/sleep')).status).toBe(403);
      expect((await keyless('/v1/quarantine', 'GET')).status).toBe(403);
    },
  );

  it.skipIf(needsHippoDb('db'))('member Bearer → 403 with admin-role-required message', async () => {
    const db = openHippoDb(home);
    let memberKey: string;
    try {
      const result = createApiKey(db, { tenantId: 'default', label: 'member-test', role: 'member' });
      memberKey = result.plaintext;
    } finally {
      closeHippoDb(db);
    }

    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${memberKey}`,
      },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(res.status).toBe(403);
    // SAFETY: this route's 403 handler always returns a JSON body shaped
    // { error: string } (src/server.ts admin-role gate on POST /v1/sleep).
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('admin role');
  });
});
