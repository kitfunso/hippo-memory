// A held write lock answers a server write with a quick 503 and Retry-After instead of stalling the event loop for seconds.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { initStore } from '../src/store/open.js';
import { getHippoDbPath, type DatabaseSyncLike } from '../src/db.js';
import { serve, type ServerHandle } from '../src/server.js';
import { log } from '../src/log.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { serveJobs } from '../src/store/sqlite/worker-jobs.js';
import type { Job, Reply } from '../src/store/sqlite/worker-ops.js';
import { countMatching, recordStatementsAsync, STORE_OPEN } from './_helpers/count-statements.js';

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
};

describe('server under a held write lock', () => {
  let home: string;
  let handle: ServerHandle;
  let holder: DatabaseSyncLike;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-busy-503-'));
    initStore(home);
    handle = await serve({ hippoRoot: home, port: 0 });
    holder = new DatabaseSync(getHippoDbPath(home));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (holder.isOpen !== false) holder.close();
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
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
  }, 20000);

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
