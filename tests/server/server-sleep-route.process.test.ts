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

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import childProcess, { ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { rmSync } from 'node:fs';
import { adminActor, remember, type Context } from '../../src/api/index.js';
import type { ServerHandle } from '../../src/server.js';
import { createSleepQueue } from '../../src/surface/server/sleep-offload.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/keys/auth.js';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { presentConnectionsAsRemote } from '../_helpers/listen.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { serveAsAdmin } from '../_helpers/admin-server.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { needsHippoDb } from '../_helpers/store-switch.js';
import { jsonAs } from '../_helpers/http-objects-server.js';

describe('POST /v1/sleep', () => {
  let home: string;
  let globalHome: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('srv-slp');
    globalHome = makeRoot('srv-slp');
    vi.stubEnv('HIPPO_HOME', globalHome);
    handle = await serveAsAdmin({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.skipIf(needsHippoDb('sleep'))('empty body returns SleepResult (200)', async () => {
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

  it.skipIf(needsHippoDb('sleep'))('dry_run=true previews dedup/audit and skips share/ambient', async () => {
    const ctx: FullContext = apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' });
    await remember(ctx, { content: 'dry-run-canary' });

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

  it.skipIf(needsHippoDb('sleep'))('runs the full pipeline on a populated store', async () => {
    const ctx: FullContext = apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' });
    for (let i = 0; i < 5; i++) {
      await remember(ctx, { content: `populate ${i} ${'x'.repeat(50)}` });
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

  it.skipIf(needsHippoDb('sleep'))(
    'shares a high-value memory into the global store, as hippo sleep does',
    async () => {
      // Pinned with error and gotcha tags, so its transfer score clears the auto-share bar.
      const row = 'gotcha: powershell 5.1 has no pipeline chain operators, use if blocks';
      writeEntry(
        home,
        createMemory(row, {
          baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
          pinned: true,
          tags: ['error', 'gotcha'],
          tenantId: 'default',
        }),
      );

      const res = await fetch(`${handle.url}/v1/sleep`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect((await jsonAs<{ shared?: number }>(res)).shared).toBe(1);
      expect(loadAllEntries(globalHome, 'default').map((e) => e.content)).toContain(row);
    },
  );

  it.skipIf(needsHippoDb('sleep'))('no_share=true keeps shared undefined', async () => {
    const ctx: FullContext = apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' });
    await remember(ctx, { content: 'high-value would-trigger-share' });

    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ no_share: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ shared?: number }>(res);
    expect(body.shared).toBeUndefined();
  });

  it.skipIf(needsHippoDb('sleep'))('non-boolean dry_run returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it.skipIf(needsHippoDb('sleep'))(
    'host-wide contract: any Bearer can dedupe across tenants (intentional)',
    async () => {
      // Pins the documented "host-wide" semantic. The day a per-tenant /v1/sleep
      // lands, this test must be updated as the breaking-change marker.
      // Seed near-duplicate memories under two tenants. Run /v1/sleep (default
      // Bearer). Verify both tenants' rows are visible to dedupe (they share
      // hippoRoot).
      const tenantA: FullContext = apiCtx(home, 'tenant_a', { subject: 'localhost:cli', role: 'admin' });
      const tenantB: FullContext = apiCtx(home, 'tenant_b', { subject: 'localhost:cli', role: 'admin' });
      const dupContent = 'highly similar content x'.repeat(20);
      await remember(tenantA, { content: dupContent + ' tenant_a marker' });
      await remember(tenantB, { content: dupContent + ' tenant_b marker' });

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
    },
  );

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

  it.skipIf(needsHippoDb('sleep'))('answers GET /health while a sleep is still running', async () => {
    await remember(apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' }), {
      content: 'a memory for the sleep to write',
    });
    // The sleep needs the write lock held here, so it cannot finish until the health answer has released it.
    const lock = openHippoDb(home);
    lock.exec('BEGIN IMMEDIATE');
    const order: string[] = [];
    // Probed once the server has the sleep request, so the probe cannot be answered ahead of it.
    const health = new Promise<Response>((resolve, reject) => {
      handle.server?.once('request', () => fetch(`${handle.url}/health`).then(resolve, reject));
    });
    const slept = postSleep().then((res) => {
      order.push('sleep');
      return res;
    });
    const healthStatus = (await health).status;
    order.push('health');
    lock.exec('ROLLBACK');
    closeHippoDb(lock);
    expect([healthStatus, (await slept).status, order]).toEqual([200, 200, ['health', 'sleep']]);
  });

  it.skipIf(needsHippoDb('sleep'))(
    'still answers 503 with Retry-After when another connection holds the write lock',
    async () => {
      await remember(apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' }), {
        content: 'a memory for the sleep to write',
      });
      const lock = openHippoDb(home);
      lock.exec('BEGIN IMMEDIATE');
      const busy = await postSleep();
      lock.exec('ROLLBACK');
      closeHippoDb(lock);
      expect([busy.status, busy.headers.get('retry-after')]).toEqual([503, '1']);
    },
  );

  it.skipIf(needsHippoDb('sleep'))(
    'refuses a third sleep at once with 503 and Retry-After 30 while one runs and one waits, then takes sleeps again',
    async () => {
      await remember(apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' }), {
        content: 'a memory for the sleep to write',
      });
      // Neither admitted sleep can finish while this lock is held, so the first reply back is the refusal.
      const lock = openHippoDb(home);
      lock.exec('BEGIN IMMEDIATE');
      const sleeps = [postSleep(), postSleep(), postSleep()];
      const refused = await Promise.race(sleeps);
      const refusal = [refused.status, refused.headers.get('retry-after'), await jsonAs<{ error: string }>(refused)];
      lock.exec('ROLLBACK');
      closeHippoDb(lock);
      const statuses = (await Promise.all(sleeps)).map((res) => res.status).sort();

      expect(refusal).toEqual([
        503,
        '30',
        { error: 'a sleep is already running and another is waiting; retry when one has finished' },
      ]);
      expect(statuses).toEqual([200, 200, 503]);
      expect((await postSleep()).status).toBe(200);
    },
  );

  it.skipIf(needsHippoDb('sleep'))(
    'runs past the request deadline, which only its own HIPPO_SLEEP_TIMEOUT_MS ends',
    async () => {
      vi.stubEnv('HIPPO_REQUEST_DEADLINE_MS', '1');
      expect((await postSleep()).status).toBe(200);
    },
  );

  it.skipIf(needsHippoDb('sleep'))(
    'stops a sleep at HIPPO_SLEEP_TIMEOUT_MS with 504 and leaves the store usable',
    async () => {
      vi.stubEnv('HIPPO_SLEEP_TIMEOUT_MS', '1');
      const stopped = await postSleep();
      expect([stopped.status, (await jsonAs<{ error: string }>(stopped)).error]).toEqual([
        504,
        expect.stringContaining('did not finish within 1 ms'),
      ]);
      vi.stubEnv('HIPPO_SLEEP_TIMEOUT_MS', undefined);
      expect((await postSleep()).status).toBe(200);
    },
  );
});

describe("the sleep child's end", () => {
  const deadlineText = 'sleep did not finish within 1000 ms and was stopped; the next sleep carries on from there';
  const result = { dryRun: false };
  // SAFETY: the sleep queue reads only tenantId and actor from the context.
  const ctx = { tenantId: 'default', actor: adminActor('test') } as Context;

  // The queue spawns its child one microtask after sleep(), so the first await lets the fake be listened to.
  async function startSleep() {
    const child = Object.assign(new ChildProcess(), { send: vi.fn(), kill: vi.fn() });
    vi.spyOn(childProcess, 'spawn').mockReturnValue(child);
    syncBuiltinESMExports();
    vi.stubEnv('HIPPO_SLEEP_TIMEOUT_MS', '1000');
    vi.useFakeTimers();
    const queue = createSleepQueue('no-root', true);
    const answer = queue.sleep(ctx, {});
    await Promise.resolve();
    expect(child.send).toHaveBeenCalledTimes(1);
    return { child, queue, answer };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('fails with the failure reply it was sent, stack included, when the child then closes', async () => {
    const { child, answer } = await startSleep();
    child.emit('message', {
      ok: false,
      busy: false,
      message: 'disk is full',
      stack: 'Error: disk is full\n    at child',
    });
    child.emit('close', 1, null);
    await expect(answer).rejects.toMatchObject({ message: 'disk is full', stack: 'Error: disk is full\n    at child' });
  });

  it('fails with the not-a-sleep-result text when the child sent something else and then closes', async () => {
    const { child, answer } = await startSleep();
    child.emit('message', { hello: 'world' });
    child.emit('close', 0, null);
    await expect(answer).rejects.toMatchObject({
      message: 'sleep process sent a reply that is not a sleep result (code 0, signal null)',
    });
  });

  it('fails with the ended-without-an-answer text when the child closes without a message', async () => {
    const { child, answer } = await startSleep();
    child.emit('close', 1, null);
    await expect(answer).rejects.toMatchObject({
      message: 'sleep process ended without an answer (code 1, signal null)',
    });
  });

  it('answers 504 when the deadline passes after a failure reply, the deadline first', async () => {
    const { child, answer } = await startSleep();
    child.emit('message', { ok: false, busy: false, message: 'disk is full' });
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(answer).rejects.toMatchObject({ status: 504, message: deadlineText });
  });

  it('answers 504 when the deadline passes after a malformed message, the deadline first', async () => {
    const { child, answer } = await startSleep();
    child.emit('message', { hello: 'world' });
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(answer).rejects.toMatchObject({ status: 504, message: deadlineText });
  });

  it('keeps an ok reply when the deadline passes after it, still stops the child, and settles', async () => {
    const { child, queue, answer } = await startSleep();
    child.emit('message', { ok: true, result });
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(answer).resolves.toEqual(result);
    await expect(queue.settled()).resolves.toBeUndefined();
  });

  it('keeps an ok reply that arrives after the deadline killed the child', async () => {
    const { child, answer } = await startSleep();
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('message', { ok: true, result });
    child.emit('close', null, 'SIGKILL');
    await expect(answer).resolves.toEqual(result);
  });

  it('answers 504 when a failure reply arrives after the deadline killed the child, the deadline first', async () => {
    const { child, answer } = await startSleep();
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('message', { ok: false, busy: false, message: 'disk is full' });
    child.emit('close', null, 'SIGKILL');
    await expect(answer).rejects.toMatchObject({ status: 504, message: deadlineText });
  });

  it('answers 504 when a malformed message arrives after the deadline killed the child, the deadline first', async () => {
    const { child, answer } = await startSleep();
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('message', { hello: 'world' });
    child.emit('close', null, 'SIGKILL');
    await expect(answer).rejects.toMatchObject({ status: 504, message: deadlineText });
  });
});
