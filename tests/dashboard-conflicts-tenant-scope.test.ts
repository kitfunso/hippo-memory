// The overview's open-conflict count and a memory's conflicts follow HIPPO_TENANT, like the memory list.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { replaceDetectedConflicts } from '../src/store/conflicts.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { serveDashboard } from '../src/dashboard.js';
import { boundPort } from './_helpers/listen.js';

const DASHBOARD_TOKEN = 'test-dashboard-token';

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { cookie: `hippo_dashboard_${port}=${DASHBOARD_TOKEN}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('dashboard conflicts are tenant-scoped', () => {
  let home: string;
  let hippoRoot: string;
  let server: Server | undefined;
  let prevTenant: string | undefined;
  let prevHippoHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-dash-conflicts-'));
    hippoRoot = join(home, '.hippo');
    mkdirSync(hippoRoot, { recursive: true });
    initStore(hippoRoot);
    prevTenant = process.env.HIPPO_TENANT;
    prevHippoHome = process.env.HIPPO_HOME;
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

  it('the overview and the memory detail count only the running tenant', async () => {
    const a1 = createMemory('tenant_a says the deploy target is fly', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: 'tenant_a' });
    const a2 = createMemory('tenant_a says the deploy target is render', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: 'tenant_a' });
    const b1 = createMemory('tenant_b says the build uses webpack', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: 'tenant_b' });
    const b2 = createMemory('tenant_b says the build uses vite', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: 'tenant_b' });
    for (const m of [a1, a2, b1, b2]) writeEntry(hippoRoot, m);
    replaceDetectedConflicts(hippoRoot, [
      { memory_a_id: a1.id, memory_b_id: a2.id, reason: 'deploy target', score: 0.9 },
      { memory_a_id: b1.id, memory_b_id: b2.id, reason: 'build tool', score: 0.8 },
    ]);

    process.env.HIPPO_TENANT = 'tenant_a';
    server = serveDashboard(hippoRoot, 0, DASHBOARD_TOKEN);
    const port = await boundPort(server);

    const overview = await get(port, '/api/overview');
    expect(overview.status).toBe(200);
    // SAFETY: /api/overview returns the Overview of dashboard-types.ts.
    const parsed = JSON.parse(overview.body) as { total: number; kpis: Array<{ id: string; value: number }> };
    expect(parsed.total).toBe(2);
    expect(parsed.kpis.find((k) => k.id === 'openConflicts')?.value).toBe(1);

    const detail = await get(port, `/api/memory/${a1.id}`);
    expect(detail.status).toBe(200);
    // SAFETY: /api/memory/:id returns the MemoryDetail of dashboard-types.ts.
    const own = JSON.parse(detail.body) as { conflicts: Array<{ reason: string; other: { id: string } }> };
    expect(own.conflicts.map((c) => c.reason)).toEqual(['deploy target']);
    expect(own.conflicts[0].other.id).toBe(a2.id);

    expect((await get(port, `/api/memory/${b1.id}`)).status).toBe(404);
  }, 15_000);
});
