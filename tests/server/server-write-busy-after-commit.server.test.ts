// A busy store never fails a routed write that already committed, and a busy 503 always means nothing landed, so the thin client may replay it.
import { afterAll, beforeAll, describe, expect, it, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import {
  openHippoDb,
  closeHippoDb,
  getHippoDbPath,
  isSqliteBusy,
  runWithRequestStores,
  type DatabaseSyncLike,
} from '../../src/db/index.js';
import { serve } from '../../src/server.js';
import * as client from '../../src/surface/cli/client.js';
import { mcpErrorResponse } from '../../src/surface/mcp/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { updateStatsUnlessBusy, copyToGlobal } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

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
  return Number(sqliteSyncStore(root).reports.stats().total_forgotten);
}

/** Holds the store's write lock while `fn` runs, or until `fn` calls the release it is handed. */
async function withLockHeld<T>(root: string, fn: (release: () => void) => Promise<T>): Promise<T> {
  const holder = new DatabaseSync(getHippoDbPath(root));
  holder.exec('BEGIN IMMEDIATE');
  const release = (): void => {
    if (holder.isTransaction) holder.exec('ROLLBACK');
  };
  try {
    return await fn(release);
  } finally {
    release();
    holder.close();
  }
}

/** Runs a routed write with the lock held until the server has refused one try busy, so the client's retry lands it. */
async function landedOnRetry<T>(root: string, write: () => Promise<T>): Promise<{ result: T; statuses: number[] }> {
  const realFetch = globalThis.fetch;
  const statuses: number[] = [];
  const spy = vi.spyOn(globalThis, 'fetch');
  try {
    const result = await withLockHeld(root, (release) => {
      spy.mockImplementation(async (...args) => {
        const res = await realFetch(...args);
        statuses.push(res.status);
        if (res.status === 503) release();
        return res;
      });
      return write();
    });
    return { result, statuses };
  } finally {
    spy.mockRestore();
  }
}

describe('routed writes under a busy store', () => {
  let home: string;
  let globalHome: string;
  let url: string;
  let stop: () => Promise<void>;
  let busyErr: Error;

  beforeAll(async () => {
    home = makeRoot('busy-after-commit');
    globalHome = makeRoot('busy-after-commit-global', { init: false });
    vi.stubEnv('HIPPO_HOME', globalHome);
    initTestStore(globalHome);
    busyErr = realBusyError(home);
    const handle = await serve({ hippoRoot: home, port: 0 });
    url = handle.url;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
  });

  it('remember: a lock held across the first tries ends in one stored row, not an error or a duplicate', async () => {
    const { result, statuses } = await landedOnRetry(home, () =>
      client.remember(url, undefined, { content: 'remember-busy-canary', force: true }),
    );
    expect(statuses).toEqual([503, 200]);
    expect(result.id).toMatch(/^mem_[0-9a-f]+$/);
    expect(count(home, `SELECT COUNT(*) AS n FROM memories WHERE content = ?`, 'remember-busy-canary')).toBe(1);
    expect(count(home, `SELECT COUNT(*) AS n FROM memories WHERE id = ?`, result.id)).toBe(1);
  });

  it('forget: a lock held across the first tries ends in one removal counted once', async () => {
    const { id } = await client.remember(url, undefined, { content: 'forget-busy-canary', force: true });
    const before = forgottenTotal(home);
    await expect(landedOnRetry(home, () => client.forget(url, undefined, id))).resolves.toEqual({
      result: { ok: true, id },
      statuses: [503, 200],
    });
    expect(count(home, `SELECT COUNT(*) AS n FROM memories WHERE id = ?`, id)).toBe(0);
    expect(forgottenTotal(home)).toBe(before + 1);
  });

  it('archiveRaw: a lock held across the first tries ends in one archive row', async () => {
    const { id } = await client.remember(url, undefined, { content: 'archive-busy-canary', kind: 'raw', force: true });
    await expect(landedOnRetry(home, () => client.archiveRaw(url, undefined, id, 'test'))).resolves.toMatchObject({
      result: { ok: true },
      statuses: [503, 200],
    });
    expect(count(home, `SELECT COUNT(*) AS n FROM raw_archive WHERE memory_id = ?`, id)).toBe(1);
    expect(count(home, `SELECT COUNT(*) AS n FROM memories WHERE id = ?`, id)).toBe(0);
  });

  it('promote: a held global lock ends in exactly one global copy and one promote audit row', async () => {
    const { id } = await client.remember(url, undefined, { content: 'promote-busy-canary', force: true });
    const { result, statuses } = await landedOnRetry(globalHome, () => client.promote(url, undefined, id));
    expect(statuses).toEqual([503, 200]);
    expect(count(globalHome, `SELECT COUNT(*) AS n FROM memories WHERE content = ?`, 'promote-busy-canary')).toBe(1);
    expect(
      count(globalHome, `SELECT COUNT(*) AS n FROM audit_log WHERE op = 'promote' AND target_id = ?`, result.globalId),
    ).toBe(1);
  });

  it('the stats counter after a committed removal skips a busy store with one warning instead of throwing', async () => {
    const before = forgottenTotal(home);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await withLockHeld(home, async () => {
        await runWithRequestStores(() => updateStatsUnlessBusy(home, { forgotten: 1 }, 'removed m1'), {
          busyWaitMs: 50,
        });
      });
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(
        /warn: removed m1, but the store was busy.* errorClass=Error/,
      );
    } finally {
      stderr.mockRestore();
    }
    expect(forgottenTotal(home)).toBe(before);
  });

  it('a stats increment a busy store refused is added to the next update for that root', async () => {
    // An earlier test left its refused increment pending; land it so this one counts only its own.
    updateStatsUnlessBusy(home, {}, 'drain');
    const before = forgottenTotal(home);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await withLockHeld(home, async () => {
        await runWithRequestStores(() => updateStatsUnlessBusy(home, { forgotten: 2 }, 'removed m2'), {
          busyWaitMs: 50,
        });
      });
    } finally {
      stderr.mockRestore();
    }
    expect(forgottenTotal(home)).toBe(before);
    updateStatsUnlessBusy(home, { forgotten: 1 }, 'removed m3');
    expect(forgottenTotal(home)).toBe(before + 3);
    updateStatsUnlessBusy(home, { forgotten: 1 }, 'removed m4');
    expect(forgottenTotal(home)).toBe(before + 4);
  });

  it('promote: a busy audit write rolls back the global copy, so a failed promote leaves nothing to duplicate', async () => {
    const { id } = await client.remember(url, undefined, { content: 'promote-audit-busy-canary', force: true });
    const globalDb = openHippoDb(globalHome);
    try {
      globalDb.exec(
        `CREATE TRIGGER fail_promote_audit BEFORE INSERT ON audit_log WHEN NEW.op = 'promote' BEGIN SELECT RAISE(ABORT, 'forced promote audit failure'); END`,
      );
    } finally {
      closeHippoDb(globalDb);
    }
    await expect(copyToGlobal(home, id)).rejects.toThrow(/forced promote audit failure/);
    expect(count(globalHome, `SELECT COUNT(*) AS n FROM memories WHERE content = ?`, 'promote-audit-busy-canary')).toBe(
      0,
    );
  });

  it('MCP: a busy store answers with a retry message, not the generic internal error', () => {
    expect(mcpErrorResponse(7, busyErr)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32603, message: expect.stringMatching(/store busy.*retry/) },
    });
  });
});
