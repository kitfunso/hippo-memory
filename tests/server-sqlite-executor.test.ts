// The predictions routes run their SQLite work on worker threads: the server answers through a held write lock, and a client sees what the in-process store gave.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeHippoDb, getHippoDbPath, openHippoDb } from '../src/db.js';
import { log } from '../src/log.js';
import { serve, type ServerHandle } from '../src/server.js';
import type { HippoStore } from '../src/store-port.js';
import { predictionMirror } from '../src/store/predictions.js';
import { createSqliteExecutor } from '../src/store/sqlite/executor.js';
import { servedPredictions, sqlitePredictions } from '../src/store/sqlite/predictions-group.js';
import { sqliteStore } from '../src/store/sqlite/store.js';
import { workerSqliteStore } from '../src/store/sqlite/worker-store.js';
import {
  auditFailures, auditRows, cleanups, execOn, get, holdWriteLock, keyFor, newRoot, onDb, patientStore, post, postText, removeLater, seen, start, undoAll,
} from './_helpers/store-worker-server.js';

const SAVE = 'predictions.savePrediction';

afterEach(undoAll);

function claims(root: string): string[] {
  // SAFETY: the SELECT names one column, which the schema declares TEXT NOT NULL.
  const rows = onDb(root, (db) => db.prepare('SELECT claim_text FROM predictions ORDER BY id').all()) as Array<{ claim_text: string }>;
  return rows.map((row) => row.claim_text);
}

const claim = (text: string) => ({ claim: text, classTag: 'release', estimate: 3, unit: 'days' });

describe('the event loop while a predictions write waits', () => {
  it('answers /health and a predictions read while a predictions write waits for the write lock, then lands the write', async () => {
    const root = newRoot();
    const { store, sent } = patientStore(root);
    const server = await start(root, store);
    expect((await post(server, '/v1/predictions', claim('warms the writer'))).status).toBe(201);
    expect((await get(server, '/v1/predictions')).status).toBe(200);

    const lock = holdWriteLock(root);
    const order: string[] = [];
    const write = post(server, '/v1/predictions', claim('behind the lock')).then((res) => {
      order.push('write');
      return res;
    });
    await sent(SAVE, 2);
    const health = await get(server, '/health');
    order.push('health');
    const read = await get(server, '/v1/predictions');
    order.push('read');

    expect([health.status, read.status]).toEqual([200, 200]);
    expect(order).toEqual(['health', 'read']);
    lock.release();
    expect((await write).status).toBe(201);
    expect(order).toEqual(['health', 'read', 'write']);
    expect(claims(root)).toEqual(['warms the writer', 'behind the lock']);
  });
});

interface Caller {
  readonly main: string;
  readonly other: string;
}

type Step = readonly [label: string, send: (server: ServerHandle, keys: Caller) => Promise<Response>];

const STEPS: readonly Step[] = [
  ['create', (s, k) => post(s, '/v1/predictions', { claim: 'ships in three days', classTag: 'release', estimate: 3, unit: 'days', targetDate: '2026-12-01' }, k.main)],
  ['create a second', (s, k) => post(s, '/v1/predictions', { claim: 'migration takes two', classTag: 'release', estimate: 2 }, k.main)],
  ['create for the other tenant', (s, k) => post(s, '/v1/predictions', { claim: 'their claim', classTag: 'release', estimate: 1 }, k.other)],
  ['create without a claim', (s, k) => post(s, '/v1/predictions', { classTag: 'release' }, k.main)],
  ['create with a broken body', (s, k) => postText(s, '/v1/predictions', '{', k.main)],
  ['create with an unknown key', (s) => post(s, '/v1/predictions', claim('never saved'), 'hk_unknown')],
  ['list', (s, k) => get(s, '/v1/predictions', k.main)],
  ['list open in a class', (s, k) => get(s, '/v1/predictions?class=release&status=open', k.main)],
  ['list one per page', (s, k) => get(s, '/v1/predictions?limit=1', k.main)],
  ['list an unknown status', (s, k) => get(s, '/v1/predictions?status=bogus', k.main)],
  ['list as the other tenant', (s, k) => get(s, '/v1/predictions', k.other)],
  ['list with an unknown key', (s) => get(s, '/v1/predictions', 'hk_unknown')],
  ['get', (s, k) => get(s, '/v1/predictions/1', k.main)],
  ['get the other tenant\'s row', (s, k) => get(s, '/v1/predictions/3', k.main)],
  ['get a missing row', (s, k) => get(s, '/v1/predictions/99', k.main)],
  ['get with an unknown key', (s) => get(s, '/v1/predictions/1', 'hk_unknown')],
  ['close', (s, k) => post(s, '/v1/predictions/1/close', { state: 'closed', actual: 5, note: 'two days late' }, k.main)],
  ['close it again', (s, k) => post(s, '/v1/predictions/1/close', { state: 'closed', actual: 5 }, k.main)],
  ['close the other tenant\'s row', (s, k) => post(s, '/v1/predictions/3/close', { state: 'closed', actual: 1 }, k.main)],
  ['close a missing row', (s, k) => post(s, '/v1/predictions/99/close', { state: 'closed', actual: 1 }, k.main)],
  ['close to an open state', (s, k) => post(s, '/v1/predictions/2/close', { state: 'open' }, k.main)],
  ['close with an unknown key', (s) => post(s, '/v1/predictions/2/close', { state: 'closed' }, 'hk_unknown')],
  ['list closed in a class', (s, k) => get(s, '/v1/predictions?class=release&status=closed', k.main)],
  ['stats', (s, k) => get(s, '/v1/predictions/stats?class=release', k.main)],
  ['stats of an empty class', (s, k) => get(s, '/v1/predictions/stats?class=nothing-here', k.main)],
  ['stats without a class', (s, k) => get(s, '/v1/predictions/stats', k.main)],
  ['stats with an unknown key', (s) => get(s, '/v1/predictions/stats?class=release', 'hk_unknown')],
];

/** Every step against a fresh store, plus the audit rows the steps left. */
async function runSteps(root: string, store?: HippoStore) {
  const main = keyFor(root, 'default');
  const other = keyFor(root, 'acme');
  const keyIds = [main.keyId, other.keyId];
  const server = await start(root, store);
  const replies = [];
  for (const [label, send] of STEPS) replies.push(await seen(label, await send(server, { main: main.plaintext, other: other.plaintext }), keyIds));
  return { replies, audit: auditRows(root, keyIds) };
}

describe('worker-backed predictions against the in-process store', () => {
  it('gives every predictions route the same status, headers, body and audit rows', async () => {
    const inProcessRoot = newRoot();
    const inProcess = await runSteps(inProcessRoot, sqliteStore(inProcessRoot));
    const onWorkers = await runSteps(newRoot());

    expect(onWorkers.replies).toEqual(inProcess.replies);
    expect(onWorkers.audit).toEqual(inProcess.audit);
    const statusOf = Object.fromEntries(onWorkers.replies.map((reply) => [reply.label, reply.status]));
    expect(statusOf).toMatchObject({
      create: 201, 'create without a claim': 400, 'create with an unknown key': 401, list: 200, get: 200, 'get the other tenant\'s row': 404,
      'get a missing row': 404, close: 200, 'close it again': 400, 'close the other tenant\'s row': 404, stats: 200, 'stats without a class': 400,
    });
  });

  it('answers a write behind a held lock with the same 503 and Retry-After', async () => {
    const busyReplies = async (root: string, store?: HippoStore) => {
      const server = await start(root, store);
      expect((await post(server, '/v1/predictions', claim('saved before the lock'))).status).toBe(201);
      const lock = holdWriteLock(root);
      const replies = [
        await seen('create', await post(server, '/v1/predictions', claim('refused'))),
        await seen('close', await post(server, '/v1/predictions/1/close', { state: 'closed', actual: 4 })),
        await seen('list', await get(server, '/v1/predictions')),
      ];
      lock.release();
      return replies;
    };
    const inProcessRoot = newRoot();
    const inProcess = await busyReplies(inProcessRoot, sqliteStore(inProcessRoot));
    const workerRoot = newRoot();
    const onWorkers = await busyReplies(workerRoot);

    expect(onWorkers).toEqual(inProcess);
    expect(onWorkers.map((reply) => reply.status)).toEqual([503, 503, 200]);
    expect(onWorkers[0]?.headers).toContainEqual(['retry-after', '1']);
    expect(claims(workerRoot)).toEqual(['saved before the lock']);
  });
});

describe('a store worker that dies', () => {
  it('answers the write it was running and the writes queued behind it with 503, then serves the next write on a fresh thread', async () => {
    const root = newRoot();
    const { store, executor, sent } = patientStore(root);
    const server = await start(root, store);
    expect((await post(server, '/v1/predictions', claim('before the crash'))).status).toBe(201);
    const lock = holdWriteLock(root);
    const lost = [1, 2, 3].map((n) => post(server, '/v1/predictions', claim(`lost ${n}`)));
    await sent(SAVE, 4);

    executor.terminateWriter();
    lock.release();
    const replies = await Promise.all(lost);

    expect(replies.map((res) => res.status)).toEqual([503, 503, 503]);
    expect(replies.map((res) => res.headers.get('retry-after'))).toEqual(['1', '1', '1']);
    expect((await post(server, '/v1/predictions', claim('after the crash'))).status).toBe(201);
    const saved = claims(root);
    expect(saved).toContain('after the crash');
    expect(saved).not.toContain('lost 2');
    expect(saved).not.toContain('lost 3');
  });
});

describe('a reader thread', () => {
  it('refuses a write sent to it as a read', async () => {
    const root = newRoot();
    const executor = createSqliteExecutor(root);
    cleanups.push(() => executor.close());
    const saved = { classTag: 'release', claimText: 'written on a reader' };
    const args = ['default', { ...saved, mirror: predictionMirror('default', saved, 30) }, 'test'];

    const write = executor.call(SAVE, args, { mode: 'read', requestId: undefined });

    await expect(write).rejects.toThrow(/readonly database/);
    expect(claims(root)).toEqual([]);
  });
});

describe("the server-thread block of a `loop: 'off'` route", () => {
  const ROUTES: ReadonlyArray<readonly [string, (server: ServerHandle) => Promise<Response>]> = [
    ['POST /v1/predictions', (s) => post(s, '/v1/predictions', claim('opened on the server thread'))],
    ['GET /v1/predictions', (s) => get(s, '/v1/predictions')],
    ['GET /v1/predictions/stats', (s) => get(s, '/v1/predictions/stats?class=release')],
    ['GET /v1/predictions/:id', (s) => get(s, '/v1/predictions/1')],
    ['POST /v1/predictions/:id/close', (s) => post(s, '/v1/predictions/1/close', { state: 'closed', actual: 2 })],
  ];

  it.each(ROUTES)('%s fails when its handler opens hippo.db on the server thread', async (_route, send) => {
    const root = newRoot();
    const info = vi.spyOn(log, 'info');
    // The worker-backed store with one group swapped back to the in-process one: the defect the block exists to catch.
    const store = Object.assign(workerSqliteStore(root), { predictions: servedPredictions(sqlitePredictions(root)) });
    const server = await start(root, store);

    const res = await send(server);

    expect(res.status).toBe(501);
    expect(info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('opened on the server thread by a route'))).toHaveLength(1);
    expect(claims(root)).toEqual([]);
  });

  it('lets an authResolver that reads hippo.db answer for a worker-backed route', async () => {
    const root = newRoot();
    vi.stubEnv('HIPPO_V1_RPS', '0');
    const server = await serve({
      hippoRoot: root,
      port: 0,
      authResolver: (token) => {
        closeHippoDb(openHippoDb(root));
        return token === 'idp-token' ? { tenantId: 'default', subject: 'idp:alice', role: 'admin' } : null;
      },
    });
    cleanups.push(() => server.stop());

    expect((await get(server, '/v1/predictions', 'idp-token')).status).toBe(200);
    expect((await get(server, '/v1/predictions', 'not-the-token')).status).toBe(401);
  });

  it('still holds the store connection when the first response of a new store is a worker-backed route', async () => {
    const root = removeLater(mkdtempSync(join(tmpdir(), 'hippo-sqlite-executor-bare-')));
    const warn = vi.spyOn(log, 'warn');
    const server = await start(root);
    expect(existsSync(getHippoDbPath(root))).toBe(false);

    expect((await post(server, '/v1/predictions', claim('creates the store'))).status).toBe(201);
    expect((await get(server, '/health')).status).toBe(200);

    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('could not hold a store connection'))).toEqual([]);
  });
});

describe('stopping a server with store workers', () => {
  it('leaves the default store folder free to remove as soon as stop() resolves', async () => {
    const root = newRoot();
    const server = await start(root);
    expect((await post(server, '/v1/predictions', claim('starts the writer'))).status).toBe(201);
    expect((await get(server, '/v1/predictions')).status).toBe(200);

    await server.stop();
    rmSync(root, { recursive: true });

    expect(existsSync(root)).toBe(false);
  });

  it('has no live thread once the store is closed', async () => {
    const root = newRoot();
    const executor = createSqliteExecutor(root);
    const store = workerSqliteStore(root, executor);
    const server = await start(root, store);
    expect(executor.liveThreads()).toBe(0);
    expect((await post(server, '/v1/predictions', claim('starts the writer'))).status).toBe(201);
    expect((await get(server, '/v1/predictions')).status).toBe(200);
    expect(executor.liveThreads()).toBe(2);

    await server.stop();
    await store.close();

    expect(executor.liveThreads()).toBe(0);
    await expect(store.predictions.listPredictions('default', { limit: 1 })).rejects.toThrow(/store is closed/);
  });
});

describe('an audit write failure counted on a worker thread', () => {
  it('reaches /health when the write kept its mutation', async () => {
    const root = newRoot();
    const server = await start(root);
    const before = await auditFailures(server);
    execOn(root, `CREATE TRIGGER remember_audit_broken BEFORE INSERT ON audit_log WHEN NEW.op = 'remember' BEGIN SELECT RAISE(ABORT, 'audit table unwritable'); END`);

    expect((await post(server, '/v1/predictions', claim('kept without its audit row'))).status).toBe(201);

    expect(await auditFailures(server)).toBe(before + 1);
    expect(claims(root)).toEqual(['kept without its audit row']);
  });
});
