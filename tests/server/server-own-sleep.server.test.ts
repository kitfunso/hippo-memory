import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SleepOptions, SleepResult } from '../../src/api/index.js';
import type { SleepEvent } from '../../src/api/sleep/events.js';
import { OTHER_STORE_MARKER } from '../../src/db/index.js';
import { HttpError, INTERNAL_ERROR_MESSAGE, STORE_NOT_PORTED_MESSAGE } from '../../src/base/errors/http-errors.js';
import { sqliteStore, type HippoStore } from '../../src/entry/store-kit.js';
import type { ServeOptions, ServerHandle } from '../../src/server.js';
import { readLocalKey } from '../../src/surface/server/local-key.js';
import { makeRoot } from '../_helpers/make-root.js';
import { bearer, newKey, stubStore } from '../_helpers/other-store-server.js';
import { serve } from '../_helpers/store-switch.js';

const EVENT: SleepEvent = { kind: 'dormantExpired', count: 2, retentionDays: 30 };
const EVENT_LINE = '  ⌛ would expire 2 dormant memories older than 30 days';
const SECOND_CALL_MESSAGE = 'a sleep is already running; retry when it has finished';

const admin = newKey('admin');

const resultFor = (opts: SleepOptions): SleepResult => ({
  active: 3,
  removed: 0,
  mergedEpisodic: 0,
  newSemantic: 0,
  dryRun: opts.dryRun === true,
  events: [EVENT],
});

describe('serve({ sleep }) on a store the hippo.db sleep child does not serve', () => {
  let handle: ServerHandle | undefined;
  let root = '';

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  const findApiKey: HippoStore['findApiKey'] = async (keyId) => (keyId === admin.keyId ? admin.record : null);

  async function serveOn(store: HippoStore, sleep?: ServeOptions['sleep']): Promise<ServerHandle> {
    vi.stubEnv('HIPPO_TENANT', admin.record.tenantId);
    handle = await serve({
      hippoRoot: root,
      port: 0,
      rateLimits: { perCaller: 'off', perAddress: 'off' },
      store,
      ...(sleep !== undefined && { sleep }),
    });
    return handle;
  }

  async function start(sleep?: ServeOptions['sleep']): Promise<ServerHandle> {
    root = makeRoot('own-sleep', { init: false });
    writeFileSync(join(root, OTHER_STORE_MARKER), 'stub');
    return serveOn(stubStore(root, { findApiKey, async close(): Promise<void> {} }), sleep);
  }

  function hippoDbWithoutConsolidation(): HippoStore {
    root = makeRoot('own-sleep-hippo-db');
    const { consolidation: _consolidation, ...store } = sqliteStore(root);
    return { ...store, findApiKey };
  }

  const postSleep = (server: ServerHandle, authorization: Record<string, string>): Promise<Response> =>
    fetch(`${server.url}/v1/sleep`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    });

  it('runs the server root sleep for a host admin and answers the sleep reply shape', async () => {
    const seen: SleepOptions[] = [];
    const server = await start(async (_ctx, opts) => {
      seen.push(opts);
      return resultFor(opts);
    });

    const res = await postSleep(server, bearer(admin));

    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 200,
      body: { active: 3, removed: 0, mergedEpisodic: 0, newSemantic: 0, dryRun: true, details: [EVENT_LINE] },
    });
    expect(seen).toEqual([{ dryRun: true, noShare: false }]);
  });

  it('runs one own sleep at a time, since one may pause every write: a second call gets 503 at once and the first still finishes', async () => {
    const seen: SleepOptions[] = [];
    let open: () => void = () => undefined;
    const latch = new Promise<void>((resolve) => {
      open = resolve;
    });
    let began: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      began = resolve;
    });
    const server = await start(async (_ctx, opts) => {
      seen.push(opts);
      began();
      await latch;
      return resultFor(opts);
    });

    try {
      const first = postSleep(server, bearer(admin));
      await running;
      const second = await postSleep(server, bearer(admin));
      expect({
        status: second.status,
        retryAfter: second.headers.get('retry-after'),
        body: await second.json(),
      }).toEqual({ status: 503, retryAfter: '30', body: { error: SECOND_CALL_MESSAGE } });
      open();
      expect((await first).status).toBe(200);
      expect(seen).toHaveLength(1);
    } finally {
      open();
    }
  });

  it('answers 500 when the sleep throws before it returns a promise, and the next sleep still runs', async () => {
    let calls = 0;
    const server = await start((_ctx, opts) => {
      calls += 1;
      if (calls === 1) throw new Error('the sleep could not start');
      return Promise.resolve(resultFor(opts));
    });

    const failed = await postSleep(server, bearer(admin));
    const failedBody: unknown = await failed.json();
    expect({ status: failed.status, body: failedBody }).toMatchObject({
      status: 500,
      body: { error: INTERNAL_ERROR_MESSAGE },
    });
    expect(JSON.stringify(failedBody)).not.toContain('the sleep could not start');
    const next = await postSleep(server, bearer(admin));

    expect(next.status).toBe(200);
    expect(calls).toBe(2);
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('answers a later rejection of the sleep with its status and Retry-After, and the next sleep still runs', async () => {
    let calls = 0;
    const server = await start(async (_ctx, opts) => {
      calls += 1;
      await Promise.resolve();
      if (calls === 1) throw new HttpError(503, 'busy', 30);
      return resultFor(opts);
    });

    const busy = await postSleep(server, bearer(admin));
    expect({
      status: busy.status,
      retryAfter: busy.headers.get('retry-after'),
      body: await busy.json(),
    }).toEqual({ status: 503, retryAfter: '30', body: { error: 'busy' } });
    const next = await postSleep(server, bearer(admin));

    expect(next.status).toBe(200);
    expect(calls).toBe(2);
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('answers 501 on a hippo.db store without the consolidation group when the server was given no sleep', async () => {
    const server = await serveOn(hippoDbWithoutConsolidation());

    const res = await postSleep(server, bearer(admin));

    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 501,
      body: { error: STORE_NOT_PORTED_MESSAGE },
    });
  });

  it('runs the given sleep, not the hippo.db child, on a hippo.db store without the consolidation group', async () => {
    const seen: SleepOptions[] = [];
    const server = await serveOn(hippoDbWithoutConsolidation(), async (_ctx, opts) => {
      seen.push(opts);
      return resultFor(opts);
    });

    const res = await postSleep(server, bearer(admin));

    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 200,
      body: { active: 3, removed: 0, mergedEpisodic: 0, newSemantic: 0, dryRun: true, details: [EVENT_LINE] },
    });
    expect(seen).toEqual([{ dryRun: true, noShare: false }]);
  });

  it('refuses the local key with 403 and never runs the sleep', async () => {
    let ran = 0;
    const server = await start(async (_ctx, opts) => {
      ran += 1;
      return resultFor(opts);
    });

    const res = await postSleep(server, { authorization: `Bearer ${readLocalKey(root)}` });

    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 403,
      body: { error: '/v1/sleep requires admin role' },
    });
    expect(ran).toBe(0);
  });
});
