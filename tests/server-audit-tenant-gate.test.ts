// GET /v1/audit?tenant=<other> is admin-only; real HTTP server, real DB.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-audit-tenant-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('GET /v1/audit?tenant= admin gate', () => {
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
    if (origHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = origHippoHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  function key(role: 'admin' | 'member'): string {
    const db = openHippoDb(home);
    try {
      return createApiKey(db, { tenantId: 'acme', label: `${role}-test`, role }).plaintext;
    } finally {
      closeHippoDb(db);
    }
  }

  const get = (qs: string, bearer: string) =>
    fetch(`${handle.url}/v1/audit${qs}`, { headers: { authorization: `Bearer ${bearer}` } });

  it('member reading another tenant gets 403', async () => {
    const res = await get('?tenant=other', key('member'));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('admin role');
  });

  it('member reading the synthetic __host__ tenant gets 403', async () => {
    expect((await get('?tenant=__host__', key('member'))).status).toBe(403);
  });

  it('member reading its own tenant, explicit or implied, gets 200', async () => {
    const k = key('member');
    expect((await get('?tenant=acme', k)).status).toBe(200);
    expect((await get('', k)).status).toBe(200);
  });

  it('admin reading another tenant gets 200', async () => {
    expect((await get('?tenant=other', key('admin'))).status).toBe(200);
  });
});
