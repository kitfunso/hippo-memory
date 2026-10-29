// hippo.db's local tier on the worker store: each local method is sent to a worker as
// `hippoDb.<repo>.<method>`, the worker runs it, and a request-bound call carries that request's limits.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { closeHippoDb, getHippoDbPath, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { META_KEY } from '../../src/db/meta.js';
import { RequestDeadline } from '../../src/base/util/request-scope.js';
import { createSqliteExecutor, type SqliteExecutor } from '../../src/store/sqlite/runtime/executor.js';
import { storeForRequest, workerSqliteStore } from '../../src/store/sqlite/runtime/worker-store.js';
import { HIPPO_DB_EFFECTS } from '../../src/store/sqlite/hippo-db.js';
import { makeRoot } from '../_helpers/make-root.js';
import { recordingExecutor } from '../_helpers/recording-executor.js';

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
};

// Far past the test's own timeout, so a write behind the held lock ends only when the test releases it.
const LONG_WAIT_MS = 60_000;
const SHORT_DEADLINE_MS = 400;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const undo of cleanups.splice(0).reverse()) await undo();
});

/** A worker store on a fresh root, closed after the test. */
function storeOn(root: string, executor: SqliteExecutor) {
  const store = workerSqliteStore(root, executor);
  cleanups.push(() => store.close());
  return store;
}

/** A second connection, as another process would hold, with the write lock taken until `release`. */
function holdWriteLock(root: string) {
  const other = new DatabaseSync(getHippoDbPath(root));
  cleanups.push(() => {
    if (other.isOpen !== false) other.close();
  });
  other.exec('BEGIN IMMEDIATE');
  return { release: () => other.exec('COMMIT') };
}

function remembered(root: string): number {
  const db = openHippoDb(root);
  try {
    const sql = 'SELECT value FROM meta WHERE key = ?';
    // SAFETY: meta.value is a TEXT NOT NULL column, and migrate seeds the counter's row.
    const row = db.prepare(sql).get(META_KEY.totalRemembered) as { value: string };
    return Number(row.value);
  } finally {
    closeHippoDb(db);
  }
}

const effectOf = (repo: string, method: string): string | undefined =>
  new Map(Object.entries(new Map(Object.entries(HIPPO_DB_EFFECTS)).get(repo) ?? {})).get(method);

describe("hippo.db's local tier on the worker store", () => {
  it('sends every local method to a worker as hippoDb.<repo>.<method>, placed by its effect', async () => {
    const { executor, sent } = recordingExecutor();
    const store = storeOn(makeRoot('hippo-db-workers'), executor);
    const walked: string[] = [];
    for (const [repo, methods] of Object.entries(store.hippoDb)) {
      for (const [method, run] of Object.entries<Function>(methods)) {
        await run();
        walked.push(`hippoDb.${repo}.${method} ${effectOf(repo, method)}`);
      }
    }
    expect(walked.length).toBeGreaterThan(0);
    expect(sent.map(({ op, mode }) => `${op} ${mode}`)).toEqual(walked);
  });

  it('runs a local write on the writer thread', async () => {
    const root = makeRoot('hippo-db-workers');
    const store = storeOn(root, createSqliteExecutor(root));
    await store.hippoDb.stats.bumpRemembered(2);
    expect(remembered(root)).toBe(2);
  });

  it("carries a request's deadline and signal, and drops a local write still queued at the deadline", async () => {
    const root = makeRoot('hippo-db-workers');
    const { executor, sent } = recordingExecutor(createSqliteExecutor(root, { busyWaitMs: LONG_WAIT_MS }));
    const store = storeOn(root, executor);
    // The writer runs the store's setup first, so the held lock stops only the writes below.
    await store.hippoDb.stats.bumpRemembered(1);
    const lock = holdWriteLock(root);
    // Keeps the one writer thread busy, so the request's write waits in its queue.
    const ahead = store.hippoDb.stats.bumpRemembered(1);
    const deadline = new RequestDeadline(Date.now() + SHORT_DEADLINE_MS);
    const { signal } = new AbortController();
    const queued = storeForRequest(store, { deadline, signal }).hippoDb.stats.bumpRemembered(5);
    await expect(queued).rejects.toThrow('so it never ran');
    lock.release();
    await ahead;
    expect(sent.at(-1)).toEqual({
      op: 'hippoDb.stats.bumpRemembered',
      mode: 'write',
      deadlineAt: deadline.at,
      signal,
    });
    expect(remembered(root)).toBe(2);
  }, 20_000);
});
