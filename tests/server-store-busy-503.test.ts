// A held write lock answers a server write with a quick 503 and Retry-After instead of stalling the event loop for seconds.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { getHippoDbPath, type DatabaseSyncLike } from '../src/db.js';
import { serve, type ServerHandle } from '../src/server.js';

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
    if (holder.isOpen !== false) holder.close();
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns 503 with Retry-After: 1 well inside the old 5 s wait, then succeeds once the lock is gone', async () => {
    holder.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    const busy = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'written while another process holds the lock' }),
    });
    const elapsed = Date.now() - started;
    holder.exec('ROLLBACK');

    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(await busy.json()).toEqual({ error: expect.stringMatching(/store busy/) });
    expect(elapsed).toBeLessThan(3000);

    const ok = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'written after the lock is released' }),
    });
    expect(ok.status).toBe(200);
  }, 20000);
});
