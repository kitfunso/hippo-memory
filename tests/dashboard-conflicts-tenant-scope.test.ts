// The dashboard's conflict list and open-conflict count follow HIPPO_TENANT, like its memory list.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { initStore, writeEntry, replaceDetectedConflicts } from '../src/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { serveDashboard } from '../src/dashboard.js';
import { boundPort } from './_helpers/listen.js';

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
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

  it('GET /api/conflicts and /api/stats count only the running tenant', async () => {
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
    server = serveDashboard(hippoRoot, 0);
    const port = await boundPort(server);

    const conflicts = await get(port, '/api/conflicts');
    expect(conflicts.status).toBe(200);
    // SAFETY: /api/conflicts returns the conflicts array built in dashboard.ts buildDashboardData.
    const rows = JSON.parse(conflicts.body) as Array<{ memory_a_id: string; memory_b_id: string; reason: string }>;
    expect(rows.map((r) => r.reason)).toEqual(['deploy target']);
    const ids = new Set(rows.flatMap((r) => [r.memory_a_id, r.memory_b_id]));
    expect(ids.has(b1.id) || ids.has(b2.id)).toBe(false);

    const stats = await get(port, '/api/stats');
    // SAFETY: /api/stats returns DashboardData.stats, which always carries open_conflicts.
    expect((JSON.parse(stats.body) as { open_conflicts: number }).open_conflicts).toBe(1);
  }, 15_000);
});
