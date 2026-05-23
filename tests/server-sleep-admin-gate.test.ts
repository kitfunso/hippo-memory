/**
 * Runtime test for v1.12.0 A5 v2 sub-1: admin-role gate on POST /v1/sleep.
 *
 * Defense-in-depth: today /v1/sleep is loopback-only, so the loopback fallback's
 * default admin role passes naturally. The role gate exists ALREADY so that
 * when non-loopback serving lands (HIPPO_BIND_ALL or A5 v2 v2 multi-tenant
 * deployment), member-role Bearer tokens are 403'd at the route boundary
 * BEFORE any host-wide consolidation runs.
 *
 * Member keys are constructed via direct DB insert per brainstorm decision #3
 * (no `hippo auth create-key --role` CLI flag in this episode).
 *
 * Real HTTP server (serve port:0), per-test isolated local + global stores.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-sleep-gate-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('POST /v1/sleep admin-role gate (v1.12.0)', () => {
  let home: string;
  let globalHome: string;
  let origHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    globalHome = makeRoot();
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    if (origHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = origHippoHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('loopback no-Bearer → 200 (loopback fallback is admin by default)', async () => {
    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(res.status).toBe(200);
  });

  it('admin Bearer → 200', async () => {
    const db = openHippoDb(home);
    let adminKey: string;
    try {
      const result = createApiKey(db, { tenantId: 'default', label: 'admin-test', role: 'admin' });
      adminKey = result.plaintext;
    } finally {
      closeHippoDb(db);
    }

    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${adminKey}`,
      },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(res.status).toBe(200);
  });

  it('member Bearer → 403 with admin-role-required message', async () => {
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
        'authorization': `Bearer ${memberKey}`,
      },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('admin role');
  });
});
