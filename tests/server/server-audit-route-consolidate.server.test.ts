import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { remember, sleepWholeStore, outcome } from '../../src/api/index.js';
import type { ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { serveAsAdmin } from '../_helpers/admin-server.js';
import { needsHippoDb } from '../_helpers/store-switch.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /v1/audit?op=<op> — consolidate + outcome wiring', () => {
  let home: string;
  let globalHome: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('audit-route');
    globalHome = makeRoot('audit-route');
    vi.stubEnv('HIPPO_HOME', globalHome);
    handle = await serveAsAdmin({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it.skipIf(needsHippoDb('db'))('round-trips a consolidate row written by api.sleep', async () => {
    const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
    await remember(ctx, { content: 'seed-for-consolidate' });
    await sleepWholeStore(ctx, { dryRun: true });

    const res = await fetch(`${handle.url}/v1/audit?op=consolidate&tenant=__host__`);
    expect(res.status).toBe(200);
    // SAFETY: GET /v1/audit's response body is the serialized AuditEvent[]
    // from src/store/audit.ts, checked immediately by the assertions below.
    const body = (await res.json()) as Array<{ op: string; actor: string }>;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((e) => e.op === 'consolidate')).toBe(true);
  });

  it('rejects a malformed ?tenant= with a 400 before the admin check', async () => {
    const res = await fetch(`${handle.url}/v1/audit?tenant=${encodeURIComponent('a/../b')}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('tenant contains invalid characters');
  });

  it.skipIf(needsHippoDb('db'))('round-trips an outcome row (drift the Set update closed)', async () => {
    const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
    const m1 = await remember(ctx, { content: 'outcome-target' });
    await outcome(ctx, [m1.id], true);

    const res = await fetch(`${handle.url}/v1/audit?op=outcome`);
    expect(res.status).toBe(200);
    // SAFETY: GET /v1/audit's response body is the serialized AuditEvent[]
    // from src/store/audit.ts, checked immediately by the assertion below.
    const body = (await res.json()) as Array<{ op: string }>;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((e) => e.op === 'outcome')).toBe(true);
  });
});
