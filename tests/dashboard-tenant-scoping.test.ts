// The dashboard derives its tenant via resolveTenantId({}), which reads HIPPO_TENANT.
// A pin for another tenant's memory id must return 404 and leave the row untouched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { initStore, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { serveDashboard } from '../src/dashboard.js';
import { boundPort } from './_helpers/listen.js';

function post(
  port: number,
  path: string,
  payload: string = '{}',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('dashboard tenant-scoping (v1.11.0 residue)', () => {
  let home: string;
  let hippoRoot: string;
  let server: Server | undefined;
  let prevTenant: string | undefined;
  let prevHippoHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-dash-tenant-'));
    hippoRoot = join(home, '.hippo');
    mkdirSync(hippoRoot, { recursive: true });
    initStore(hippoRoot);
    prevTenant = process.env.HIPPO_TENANT;
    prevHippoHome = process.env.HIPPO_HOME;
    // Isolate the dashboard's resolved global store from the developer's real
    // ~/.hippo for the duration of the test.
    process.env.HIPPO_HOME = join(home, '.hippo-global');
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((err) => (err ? reject(err) : resolve())),
      );
      server = undefined;
    }
    if (prevTenant === undefined) delete process.env.HIPPO_TENANT;
    else process.env.HIPPO_TENANT = prevTenant;
    if (prevHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = prevHippoHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('POST /api/memory/:id/pin denies a cross-tenant mutation', async () => {
    // Seed a memory under tenant_a in the local store.
    const a = createMemory('tenant_a memory', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tenantId: 'tenant_a',
      tags: ['x'],
    });
    writeEntry(hippoRoot, a);

    // Run the dashboard under HIPPO_TENANT=tenant_b on an ephemeral port.
    process.env.HIPPO_TENANT = 'tenant_b';
    server = serveDashboard(hippoRoot, 0);
    const port = await boundPort(server);

    const res = await post(port, `/api/memory/${a.id}/pin`, '{"pinned":true}');
    expect(res.status).toBe(404);

    // The tenant_a memory is still unpinned in the DB.
    const db = openHippoDb(hippoRoot);
    try {
      // SAFETY: the SELECT names one column of the row seeded above, which exists.
      const row = db
        .prepare(`SELECT pinned FROM memories WHERE id = ?`)
        .get(a.id) as { pinned: number };
      expect(row.pinned).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  }, 15_000);
});
