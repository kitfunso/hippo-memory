/**
 * v1.11.0 tenant-isolation residue: dashboard POST /api/star/:id must deny
 * cross-tenant mutations.
 *
 * The dashboard process derives its tenant via resolveTenantId({}) (which
 * reads HIPPO_TENANT). A star-toggle for another tenant's memory id must
 * return 404 and leave the memory's starred field untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { initStore, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createMemory } from '../src/memory.js';
import { serveDashboard } from '../src/dashboard.js';

function post(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST' },
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
    req.end();
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

  it('POST /api/star/:id denies a cross-tenant mutation', async () => {
    // Seed a memory under tenant_a in the local store.
    const a = createMemory('tenant_a memory', {
      tenantId: 'tenant_a',
      tags: ['x'],
    });
    writeEntry(hippoRoot, a);

    // Run the dashboard under HIPPO_TENANT=tenant_b on an ephemeral port.
    process.env.HIPPO_TENANT = 'tenant_b';
    const port = 31000 + Math.floor(Math.random() * 5000);
    server = serveDashboard(hippoRoot, port);
    await new Promise<void>((resolve) => {
      if (server!.listening) resolve();
      else server!.once('listening', () => resolve());
    });

    // POST /api/star/<tenant_a memory id> under HIPPO_TENANT=tenant_b → 404.
    const res = await post(port, `/api/star/${a.id}`);
    expect(res.status).toBe(404);

    // The tenant_a memory's starred field is unchanged in the DB.
    const db = openHippoDb(hippoRoot);
    try {
      const row = db
        .prepare(`SELECT starred FROM memories WHERE id = ?`)
        .get(a.id) as { starred: number };
      expect(row.starred).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  }, 15_000);
});
