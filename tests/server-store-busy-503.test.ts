// A held write lock answers a server write with a quick 503 and Retry-After instead of stalling the event loop for seconds.
import { afterAll, beforeAll, describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { getHippoDbPath, type DatabaseSyncLike } from '../src/db/index.js';
import { serve, type ServerHandle } from '../src/server.js';
import { log } from '../src/util/log.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { serveJobs } from '../src/store/sqlite/worker-jobs.js';
import type { Job, Reply } from '../src/store/sqlite/worker-ops.js';
import { countMatching, recordStatementsAsync, STORE_OPEN } from './_helpers/count-statements.js';
import { makeRoot } from './_helpers/make-root.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
};

describe('server under a held write lock', () => {
  let home: string;
  let handle: ServerHandle;
  let holder: DatabaseSyncLike;

  beforeAll(async () => {
    home = makeRoot('busy-503');
    handle = await serve({ hippoRoot: home, port: 0 });
    holder = new DatabaseSync(getHippoDbPath(home));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (holder.isOpen !== false) holder.close();
    await handle.stop();
  });

  it('returns 503 with Retry-After: 1 well inside the old 5 s wait, logs it as a warning, then succeeds once the lock is gone', async () => {
    const warn = vi.spyOn(log, 'warn');
    const error = vi.spyOn(log, 'error');
    holder.exec('BEGIN IMMEDIATE');
    const { result: busy, statements } = await recordStatementsAsync(() => fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'written while another process holds the lock' }),
    }));
    holder.exec('ROLLBACK');

    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(await busy.json()).toEqual({ error: expect.stringMatching(/store busy/) });
    // The write waits on the store's writer thread, so the request opened no connection on this one.
    expect(countMatching(statements, STORE_OPEN)).toBe(0);
    const failureLine = (call: unknown[]): boolean => String(call[0]).startsWith('POST /v1/memories failed');
    expect(warn.mock.calls.filter(failureLine)).toHaveLength(1);
    expect(error.mock.calls.filter(failureLine)).toHaveLength(0);

    const ok = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'written after the lock is released' }),
    });
    expect(ok.status).toBe(200);
  });

  it("opens a store worker's connection with the wait its executor passed and tries a write behind the lock once", async () => {
    const { port1, port2 } = new MessageChannel();
    const replied = new Promise<Reply>((resolve) => port2.once('message', resolve));
    const entry = createMemory('sent to the job loop while another process holds the lock', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: 'default' });
    const job: Job = { id: 1, op: 'entryWrites.writeEntry', args: [{ entry, actor: 'test' }], requestId: undefined, walPages: 100 };
    holder.exec('BEGIN IMMEDIATE');
    // The worker's own job loop, run on this thread so its statements can be read; 7 is a wait no default has.
    const { result: reply, statements } = await recordStatementsAsync(() => {
      serveJobs(port1, { hippoRoot: home, mode: 'write', busyWaitMs: 7 });
      port2.postMessage(job);
      return replied;
    });
    holder.exec('ROLLBACK');
    const closed = new Promise((resolve) => port2.once('close', resolve));
    port2.postMessage('stop');
    await closed;

    expect(reply).toMatchObject({ id: 1, ok: false, error: { message: 'database is locked', fields: { errcode: 5 } } });
    expect(new Set(statements.filter((sql) => STORE_OPEN.test(sql)))).toEqual(new Set(['PRAGMA busy_timeout = 7']));
    expect(countMatching(statements, 'BEGIN IMMEDIATE')).toBe(1);
  });
});
