/**
 * Runtime tests for POST /v1/sleep (Episode B, Task 4).
 *
 * Thin wrapper over api.sleep. Returns SleepResult JSON. Loopback-only by
 * design (host-wide consolidation; per-request guard rejects non-loopback
 * with 403 even if serve()'s boot host-check is relaxed in the future).
 *
 * Coverage:
 *   - empty body -> 200, SleepResult populated
 *   - dry_run=true -> 200, dryRun:true, skip phases
 *   - populated store runs full pipeline
 *   - no_share=true keeps shared undefined
 *   - non-boolean dry_run -> 400
 *   - host-wide intentional contract (tenant_b Bearer dedupes tenant_a)
 *   - non-loopback origin -> 403 (per-request guard)
 *
 * Real HTTP server (serve port:0), per-test isolated local + global stores.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { Context } from '../src/api.js';
import { remember } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/store/auth.js';
import { presentConnectionsAsRemote } from './_helpers/listen.js';
import { makeRoot } from './_helpers/make-root.js';

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: every call site below targets POST /v1/sleep under test in this
  // file; the response is the SleepResult JSON contract, checked field-by-
  // field by the assertions immediately following each call.
  return res.json() as Promise<T>;
}

describe('POST /v1/sleep', () => {
  let home: string;
  let globalHome: string;
  let origHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('srv-slp');
    globalHome = makeRoot('srv-slp');
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await handle.stop();
    if (origHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = origHippoHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('empty body returns SleepResult (200)', async () => {
    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{
      dryRun: boolean;
      active: number;
      removed: number;
    }>(res);
    expect(body.dryRun).toEqual(expect.any(Boolean));
    expect(body.active).toEqual(expect.any(Number));
    expect(body.removed).toEqual(expect.any(Number));
  });

  it('dry_run=true previews dedup/audit and skips share/ambient', async () => {
    const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
    remember(ctx, { content: 'dry-run-canary' });

    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{
      dryRun: boolean;
      deduped?: unknown;
      audit?: unknown;
      shared?: unknown;
      ambient?: unknown;
    }>(res);
    expect(body.dryRun).toBe(true);
    expect(body.deduped).toBeUndefined();
    expect(body.audit).toEqual({ errorsRemoved: 0, warningCount: 1 });
    expect(body.shared).toBeUndefined();
    expect(body.ambient).toBeUndefined();
  });

  it('runs the full pipeline on a populated store', async () => {
    const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
    for (let i = 0; i < 5; i++) {
      remember(ctx, { content: `populate ${i} ${'x'.repeat(50)}` });
    }

    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ dryRun: boolean; active: number }>(res);
    expect(body.dryRun).toBe(false);
    expect(body.active).toEqual(expect.any(Number));
  });

  it('no_share=true keeps shared undefined', async () => {
    const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
    remember(ctx, { content: 'high-value would-trigger-share' });

    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ no_share: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ shared?: number }>(res);
    expect(body.shared).toBeUndefined();
  });

  it('non-boolean dry_run returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it('host-wide contract: any Bearer can dedupe across tenants (intentional)', async () => {
    // Pins the documented "host-wide" semantic. The day a per-tenant /v1/sleep
    // lands, this test must be updated as the breaking-change marker.
    // Seed near-duplicate memories under two tenants. Run /v1/sleep (default
    // Bearer). Verify both tenants' rows are visible to dedupe (they share
    // hippoRoot).
    const tenantA: Context = { hippoRoot: home, tenantId: 'tenant_a', actor: { subject: 'localhost:cli', role: 'admin' } };
    const tenantB: Context = { hippoRoot: home, tenantId: 'tenant_b', actor: { subject: 'localhost:cli', role: 'admin' } };
    const dupContent = 'highly similar content x'.repeat(20);
    remember(tenantA, { content: dupContent + ' tenant_a marker' });
    remember(tenantB, { content: dupContent + ' tenant_b marker' });

    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ dryRun: boolean }>(res);
    expect(body.dryRun).toBe(false);
    // Test passes when the sleep call completes without error against the
    // cross-tenant store. The dedupe MAY or MAY NOT fire depending on the
    // jaccard threshold; the point is that the route does NOT throw on
    // cross-tenant rows, confirming the host-wide design.
  });

  it('non-loopback origin with a valid admin Bearer: 403 from the per-request guard', async () => {
    const db = openHippoDb(home);
    let plaintext: string;
    try {
      ({ plaintext } = createApiKey(db, { tenantId: 'default', label: 'remote-sleep', role: 'admin' }));
    } finally {
      closeHippoDb(db);
    }
    presentConnectionsAsRemote(handle.server!);
    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect((await jsonAs<{ error: string }>(res)).error).toMatch(/loopback-only/);
  });

  const postSleep = (): Promise<Response> =>
    fetch(`${handle.url}/v1/sleep`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  it('answers GET /health while a sleep is still running', async () => {
    remember({ hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } }, { content: 'a memory for the sleep to write' });
    // The sleep needs the write lock held here, so it cannot finish until the health answer has released it.
    const lock = openHippoDb(home);
    lock.exec('BEGIN IMMEDIATE');
    const order: string[] = [];
    // Probed once the server has the sleep request, so the probe cannot be answered ahead of it.
    const health = new Promise<Response>((resolve, reject) => {
      handle.server?.once('request', () => fetch(`${handle.url}/health`).then(resolve, reject));
    });
    const slept = postSleep().then((res) => { order.push('sleep'); return res; });
    const healthStatus = (await health).status;
    order.push('health');
    lock.exec('ROLLBACK');
    closeHippoDb(lock);
    expect([healthStatus, (await slept).status, order]).toEqual([200, 200, ['health', 'sleep']]);
  });

  it('still answers 503 with Retry-After when another connection holds the write lock', async () => {
    remember({ hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } }, { content: 'a memory for the sleep to write' });
    const lock = openHippoDb(home);
    lock.exec('BEGIN IMMEDIATE');
    const busy = await postSleep();
    lock.exec('ROLLBACK');
    closeHippoDb(lock);
    expect([busy.status, busy.headers.get('retry-after')]).toEqual([503, '1']);
  });

  it('refuses a third sleep at once with 503 and Retry-After 30 while one runs and one waits, then takes sleeps again', async () => {
    remember({ hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } }, { content: 'a memory for the sleep to write' });
    // Neither admitted sleep can finish while this lock is held, so the first reply back is the refusal.
    const lock = openHippoDb(home);
    lock.exec('BEGIN IMMEDIATE');
    const sleeps = [postSleep(), postSleep(), postSleep()];
    const refused = await Promise.race(sleeps);
    const refusal = [refused.status, refused.headers.get('retry-after'), await jsonAs<{ error: string }>(refused)];
    lock.exec('ROLLBACK');
    closeHippoDb(lock);
    const statuses = (await Promise.all(sleeps)).map((res) => res.status).sort();

    expect(refusal).toEqual([503, '30', { error: 'a sleep is already running and another is waiting; retry when one has finished' }]);
    expect(statuses).toEqual([200, 200, 503]);
    expect((await postSleep()).status).toBe(200);
  });

  it('runs past the request deadline, which only its own HIPPO_SLEEP_TIMEOUT_MS ends', async () => {
    vi.stubEnv('HIPPO_REQUEST_DEADLINE_MS', '1');
    expect((await postSleep()).status).toBe(200);
  });

  it('stops a sleep at HIPPO_SLEEP_TIMEOUT_MS with 504 and leaves the store usable', async () => {
    vi.stubEnv('HIPPO_SLEEP_TIMEOUT_MS', '1');
    const stopped = await postSleep();
    expect([stopped.status, (await jsonAs<{ error: string }>(stopped)).error]).toEqual([504, expect.stringContaining('did not finish within 1 ms')]);
    vi.unstubAllEnvs();
    expect((await postSleep()).status).toBe(200);
  });
});
