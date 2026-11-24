import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { serveDashboard } from '../../src/surface/server/dashboard-listener.js';
import type { ServerHandle } from '../../src/surface/server/types.js';
import { DASHBOARD_TOKEN, sessionCookie } from '../_helpers/dashboard-fixture.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function post(port: number, path: string, payload: string = '{}'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: sessionCookie(port) },
      },
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

describe('dashboard tenant-scoping', () => {
  let home: string;
  let hippoRoot: string;
  let server: ServerHandle | undefined;

  beforeEach(() => {
    ({ base: home, root: hippoRoot } = makeStore('dash-tenant'));
    vi.stubEnv('HIPPO_HOME', join(home, '.hippo-global'));
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('POST /api/memory/:id/pin denies a cross-tenant mutation', async () => {
    const a = createMemory('tenant_a memory', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tenantId: 'tenant_a',
      tags: ['x'],
    });
    writeEntry(hippoRoot, a);

    server = await serveDashboard({ hippoRoot, port: 0, token: DASHBOARD_TOKEN, tenantId: 'tenant_b' });
    const { port } = server;

    const res = await post(port, `/api/memory/${a.id}/pin`, '{"pinned":true}');
    expect(res.status).toBe(404);

    const db = openHippoDb(hippoRoot);
    try {
      // SAFETY: the SELECT names one column of the row seeded above, which exists.
      const row = db.prepare(`SELECT pinned FROM memories WHERE id = ?`).get(a.id) as { pinned: number };
      expect(row.pinned).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});
