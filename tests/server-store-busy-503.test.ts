// A held write lock answers a server write with a quick 503 and Retry-After instead of stalling the event loop for seconds.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { getHippoDbPath, SERVER_DB_WAIT_MS, type DatabaseSyncLike } from '../src/db.js';
import { serve, type ServerHandle } from '../src/server.js';
import { log } from '../src/log.js';
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
    // Every connection the request opened asked for the short server wait, and the write was tried once: that is what keeps the 503 quick.
    expect(new Set(statements.filter((sql) => STORE_OPEN.test(sql)))).toEqual(new Set([`PRAGMA busy_timeout = ${SERVER_DB_WAIT_MS}`]));
    expect(countMatching(statements, 'BEGIN IMMEDIATE')).toBe(1);
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
});
