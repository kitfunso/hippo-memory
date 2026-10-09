// A busy store never fails a routed write that already committed, and a busy 503 always means nothing landed, so the thin client may replay it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { loadStats, updateStatsUnlessBusy } from '../src/store/index-and-stats.js';
import { openHippoDb, closeHippoDb, getHippoDbPath, isSqliteBusy, runWithRequestStores, type DatabaseSyncLike } from '../src/db/index.js';
import { promoteToGlobal } from '../src/sharing/global-store.js';
import { resetLogOnce } from '../src/util/log.js';
import { serve } from '../src/server.js';
import * as client from '../src/cli/client.js';
import { mcpErrorResponse } from '../src/mcp/server.js';

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
};

/** A genuine SQLITE_BUSY from node:sqlite, so every check classifies it exactly as it would a held lock. */
function realBusyError(dir: string): Error {
  const file = join(dir, 'busy-probe.db');
  const holder = new DatabaseSync(file);
  holder.exec('CREATE TABLE IF NOT EXISTS t (x)');
  holder.exec('BEGIN IMMEDIATE');
  const other = new DatabaseSync(file);
  other.exec('PRAGMA busy_timeout = 0');
  try {
    other.exec('INSERT INTO t VALUES (1)');
  } catch (err) {
    if (err instanceof Error && isSqliteBusy(err)) return err;
    throw err;
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
    other.close();
  }
  throw new Error('expected SQLITE_BUSY from the probe');
}

function count(root: string, sql: string, ...params: string[]): number {
  const db = openHippoDb(root);
  try {
    // SAFETY: every caller selects a single COUNT(*) AS n column.
    return Number((db.prepare(sql).get(...params) as { n: number }).n);
  } finally {
    closeHippoDb(db);
  }
}

function forgottenTotal(root: string): number {
  return Number(loadStats(root).total_forgotten);
}

/** Holds the store's write lock until `releaseMs`, long enough that the first tries answer 503. */
async function withLockHeld<T>(root: string, releaseMs: number, fn: () => Promise<T>): Promise<T> {
  const holder = new DatabaseSync(getHippoDbPath(root));
  holder.exec('BEGIN IMMEDIATE');
  const timer = setTimeout(() => holder.exec('ROLLBACK'), releaseMs);
  try {
    return await fn();
  } finally {
    clearTimeout(timer);
    if (holder.isTransaction) holder.exec('ROLLBACK');
    holder.close();
  }
}

describe('routed writes under a busy store', () => {
  let home: string;
  let globalHome: string;
  let url: string;
  let stop: () => Promise<void>;
  let busyErr: Error;
  const savedHome = process.env.HIPPO_HOME;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-busy-after-commit-'));
    globalHome = mkdtempSync(join(tmpdir(), 'hippo-busy-after-commit-global-'));
    process.env.HIPPO_HOME = globalHome;
    initStore(home);
    initStore(globalHome);
    busyErr = realBusyError(home);
    const handle = await serve({ hippoRoot: home, port: 0 });
    url = handle.url;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
    if (savedHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('remember: a lock held across the first tries ends in one stored row, not an error or a duplicate', async () => {
    const result = await withLockHeld(home, 1200, () => client.remember(url, undefined, { content: 'remember-busy-canary' }));
    expect(result.id).toBeTruthy();
    expect(count(home, `SELECT COUNT(*) AS n FROM memories WHERE content = ?`, 'remember-busy-canary')).toBe(1);
  }, 15_000);

  it('forget: a lock held across the first tries ends in one removal counted once', async () => {
    const { id } = await client.remember(url, undefined, { content: 'forget-busy-canary' });
    const before = forgottenTotal(home);
    await expect(withLockHeld(home, 1200, () => client.forget(url, undefined, id))).resolves.toEqual({ ok: true, id });
    expect(count(home, `SELECT COUNT(*) AS n FROM memories WHERE id = ?`, id)).toBe(0);
    expect(forgottenTotal(home)).toBe(before + 1);
  }, 15_000);

  it('archiveRaw: a lock held across the first tries ends in one archive row', async () => {
    const { id } = await client.remember(url, undefined, { content: 'archive-busy-canary', kind: 'raw' });
    await expect(withLockHeld(home, 1200, () => client.archiveRaw(url, undefined, id, 'test'))).resolves.toMatchObject({ ok: true });
    expect(count(home, `SELECT COUNT(*) AS n FROM raw_archive WHERE memory_id = ?`, id)).toBe(1);
    expect(count(home, `SELECT COUNT(*) AS n FROM memories WHERE id = ?`, id)).toBe(0);
  }, 15_000);

  it('promote: a held global lock ends in exactly one global copy and one promote audit row', async () => {
    const { id } = await client.remember(url, undefined, { content: 'promote-busy-canary' });
    const result = await withLockHeld(globalHome, 1200, () => client.promote(url, undefined, id));
    expect(count(globalHome, `SELECT COUNT(*) AS n FROM memories WHERE content = ?`, 'promote-busy-canary')).toBe(1);
    expect(count(globalHome, `SELECT COUNT(*) AS n FROM audit_log WHERE op = 'promote' AND target_id = ?`, result.globalId)).toBe(1);
  }, 15_000);

  it('the stats counter after a committed removal skips a busy store with one warning instead of throwing', async () => {
    resetLogOnce();
    const before = forgottenTotal(home);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await withLockHeld(home, 60_000, async () => {
        await runWithRequestStores(() => updateStatsUnlessBusy(home, { forgotten: 1 }, 'removed m1'), { busyWaitMs: 50 });
      });
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/warn: removed m1, but the store was busy/);
    } finally {
      stderr.mockRestore();
    }
    expect(forgottenTotal(home)).toBe(before);
  });

  it('promote: a busy audit write rolls back the global copy, so a failed promote leaves nothing to duplicate', async () => {
    const { id } = await client.remember(url, undefined, { content: 'promote-audit-busy-canary' });
    expect(() => promoteToGlobal(home, id, { afterWrite: () => { throw busyErr; } })).toThrow(busyErr);
    expect(count(globalHome, `SELECT COUNT(*) AS n FROM memories WHERE content = ?`, 'promote-audit-busy-canary')).toBe(0);
  });

  it('MCP: a busy store answers with a retry message, not the generic internal error', () => {
    expect(mcpErrorResponse(7, busyErr)).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32603, message: expect.stringMatching(/store busy.*retry/) } });
  });
});
