// The store workers' queue cap, a request's deadline in the queue, on a reader and on the writer, and the handler deadline, each held open by a real lock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { closeHippoDb, getHippoDbPath, openHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import { STORE_BUSY_MESSAGE, StoreBusyError } from '../src/store/port.js';
import type { JsonValue } from '../src/util/json.js';
import { log, type LogFields } from '../src/util/log.js';
import { serve, type AuthResolver, type ServeOpts, type ServerHandle } from '../src/server.js';
import { type CallOptions, createSqliteExecutor, type ExecutorOptions, type SqliteExecutor } from '../src/store/sqlite/executor.js';
import { initStore } from '../src/store/open.js';
import { sqliteStore } from '../src/store/sqlite/store.js';
import { workerSqliteStore } from '../src/store/sqlite/worker-store.js';
import { makeRoot } from './_helpers/make-root.js';

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSyncLike };

const SAVE = 'predictions.savePrediction';
// Far past any test's own timeout, so a call behind a held lock can only end when the test releases the lock or the executor stops the thread.
const LONG_WAIT_MS = 60_000;
// Long enough that the request is on its worker before it expires; the tests wait for the expiry and never for a clock.
const SHORT_DEADLINE_MS = '400';
const PAST_DEADLINE = "past its request's deadline";

type Cleanup = () => Promise<void> | void;
const cleanups: Cleanup[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const undo of cleanups.splice(0).reverse()) await undo();
});

function removeLater(root: string): string {
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

const newRoot = (): string => removeLater(makeRoot('store-deadlines'));

/** The deadline of every request that arrives from now on; '0' turns it off. */
function deadline(ms: string): void {
  vi.stubEnv('HIPPO_REQUEST_DEADLINE_MS', ms);
}

async function start(root: string, opts: Partial<ServeOpts> = {}): Promise<ServerHandle> {
  vi.stubEnv('HIPPO_V1_RPS', '0');
  const server = await serve({ hippoRoot: root, port: 0, ...opts });
  cleanups.push(async () => {
    await server.stop();
    await opts.store?.close();
  });
  return server;
}

/** The real executor, plus a promise that settles once an op has been handed to it a given number of times. */
function watched(inner: SqliteExecutor) {
  const seen: string[] = [];
  const checks: Array<() => void> = [];
  const executor: SqliteExecutor = {
    call: <T>(op: string, args: readonly unknown[], opts: CallOptions) => {
      const result = inner.call<T>(op, args, opts);
      seen.push(op);
      for (const check of checks) check();
      return result;
    },
    close: () => inner.close(),
    liveThreads: () => inner.liveThreads(),
    terminateWriter: () => inner.terminateWriter(),
  };
  const sent = (op: string, times: number): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (seen.filter((name) => name === op).length >= times) resolve();
      };
      checks.push(check);
      check();
    });
  return { executor, sent };
}

/** A worker-backed store whose threads wait on a lock for as long as the test holds it. */
function patientStore(root: string, opts: ExecutorOptions = {}) {
  const { executor, sent } = watched(createSqliteExecutor(root, { busyWaitMs: LONG_WAIT_MS, ...opts }));
  return { sent, store: workerSqliteStore(root, executor) };
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

/** Settles when a line holding `text` is logged at `level`; set before the request that causes it. */
function logged(level: 'warn' | 'error', text: string): Promise<void> {
  return new Promise((resolve) => {
    vi.spyOn(log, level).mockImplementation((message) => {
      if (message.includes(text)) resolve();
    });
  });
}

const LATE = 'after its deadline reply';

/** Settles with the fields of the first line holding `text` logged at `level`; set before the request that causes it. */
function loggedFields(level: 'warn' | 'info', text: string): Promise<LogFields | undefined> {
  return new Promise((resolve) => {
    vi.spyOn(log, level).mockImplementation((message, fields) => {
      if (message.includes(text)) resolve(fields);
    });
  });
}

function columnOf(root: string, sql: string): string[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: every caller's SELECT names one TEXT NOT NULL column as `value`.
    const rows = db.prepare(sql).all() as Array<{ value: string }>;
    return rows.map((row) => row.value);
  } finally {
    closeHippoDb(db);
  }
}

const claims = (root: string): string[] => columnOf(root, 'SELECT claim_text AS value FROM predictions ORDER BY id');
const auditOps = (root: string): string[] => columnOf(root, 'SELECT op AS value FROM audit_log ORDER BY id');

const JSON_TYPE = { 'content-type': 'application/json' };
const post = (server: ServerHandle, path: string, body: JsonValue): Promise<Response> =>
  fetch(`${server.url}${path}`, { method: 'POST', headers: JSON_TYPE, body: JSON.stringify(body) });
const get = (server: ServerHandle, path: string): Promise<Response> => fetch(`${server.url}${path}`, { headers: JSON_TYPE });
const claim = (text: string) => ({ claim: text, classTag: 'release', estimate: 3, unit: 'days' });
const save = (server: ServerHandle, text: string): Promise<Response> => post(server, '/v1/predictions', claim(text));

interface Counts {
  readonly store_queue_refusals: number;
  readonly store_jobs_expired: number;
  readonly store_workers_replaced: number;
  readonly handler_deadlines: number;
}

async function counts(server: ServerHandle): Promise<Counts> {
  // SAFETY: the loopback /health body carries the four counts as numbers; the arithmetic on them would fail on anything else.
  return (await (await get(server, '/health')).json()) as Counts;
}

/** What a 504 of the deadline must carry: the code, the request's own id, and the sentence that says what became of the work. */
async function expectDeadlineReply(res: Response, sentence: string): Promise<void> {
  expect(res.status).toBe(504);
  expect(await res.json()).toEqual({ error: expect.stringContaining(sentence), code: 'deadline_exceeded', requestId: res.headers.get('x-request-id') });
}

async function expectBusyReply(res: Response): Promise<void> {
  expect([res.status, res.headers.get('retry-after')]).toEqual([503, '1']);
  expect(await res.json()).toEqual({ error: STORE_BUSY_MESSAGE });
}

const KILLED_WRITER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
db.exec('BEGIN IMMEDIATE');
const insert = db.prepare("INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) VALUES ('t', 'default', 'kill-proof', 'uncommitted', NULL, '{}')");
for (let i = 0; i < 500; i++) insert.run();
parentPort.postMessage('in-transaction');
if (workerData.during === 'statement') {
  // Runs for seconds; were the thread to live past it, the lines below would commit.
  db.prepare('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 40000000) SELECT count(*) FROM c').get();
  Atomics.store(new Int32Array(workerData.flag), 0, 1);
  db.exec('COMMIT');
  parentPort.postMessage('committed');
} else {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
`;

describe('a writer thread killed inside an open transaction on a WAL database', () => {
  it.each(['between statements', 'statement'])('leaves the file consistent with none of its rows, and the next write lands (killed during: %s)', async (during) => {
    const root = newRoot();
    const file = getHippoDbPath(root);
    const flag = new SharedArrayBuffer(4);
    const messages: string[] = [];
    const worker = new Worker(KILLED_WRITER, { eval: true, execArgv: ['--no-warnings'], workerData: { file, during, flag } });
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    await new Promise<void>((resolve) => worker.on('message', (message: string) => { messages.push(message); resolve(); }));

    void worker.terminate();
    await exited;

    const next = new DatabaseSync(file);
    cleanups.push(() => next.close());
    next.exec('PRAGMA busy_timeout = 0');
    expect(next.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(next.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect([messages, new Int32Array(flag)[0]]).toEqual([['in-transaction'], 0]);
    expect(next.prepare("SELECT count(*) AS n FROM audit_log WHERE op = 'uncommitted'").get()).toEqual({ n: 0 });
    next.exec("INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) VALUES ('t', 'default', 'kill-proof', 'after', NULL, '{}')");
    expect(next.prepare("SELECT count(*) AS n FROM audit_log WHERE op = 'after'").get()).toEqual({ n: 1 });
  }, 120_000);
});

describe("a store thread's queue", () => {
  it('refuses the call past HIPPO_STORE_QUEUE_MAX at once with the busy 503, and keeps the calls already waiting', async () => {
    const root = newRoot();
    deadline('0');
    vi.stubEnv('HIPPO_STORE_QUEUE_MAX', '2');
    const { store, sent } = patientStore(root);
    const server = await start(root, { store });
    expect((await save(server, 'warms the writer')).status).toBe(201);
    const before = await counts(server);
    const lock = holdWriteLock(root);
    const kept: Array<Promise<Response>> = [];
    for (const n of [1, 2, 3]) {
      kept.push(save(server, `kept ${n}`));
      await sent(SAVE, n + 1);
    }

    const refused = await save(server, 'refused');

    await expectBusyReply(refused);
    expect((await counts(server)).store_queue_refusals).toBe(before.store_queue_refusals + 1);
    lock.release();
    expect((await Promise.all(kept)).map((res) => res.status)).toEqual([201, 201, 201]);
    expect(claims(root)).toEqual(['warms the writer', 'kept 1', 'kept 2', 'kept 3']);
  });

  it("answers a call still waiting at its request's deadline with the busy 503 and never runs it", async () => {
    const root = newRoot();
    deadline('0');
    const { store, sent } = patientStore(root);
    const server = await start(root, { store });
    expect((await save(server, 'warms the writer')).status).toBe(201);
    const before = await counts(server);
    const lock = holdWriteLock(root);
    const running = save(server, 'runs when the lock is free');
    await sent(SAVE, 2);

    deadline(SHORT_DEADLINE_MS);
    const waited = await save(server, 'expired in the queue');

    await expectBusyReply(waited);
    expect((await counts(server)).store_jobs_expired).toBe(before.store_jobs_expired + 1);
    lock.release();
    expect((await running).status).toBe(201);
    expect(claims(root)).toEqual(['warms the writer', 'runs when the lock is free']);
  });

  it('refuses a call whose deadline has already passed', async () => {
    const root = newRoot();
    const executor = createSqliteExecutor(root);
    cleanups.push(() => executor.close());

    const call = executor.call('predictions.listPredictions', ['default', { limit: 1 }], { mode: 'read', requestId: undefined, deadlineAt: Date.now() - 1 });

    await expect(call).rejects.toBeInstanceOf(StoreBusyError);
    expect(executor.liveThreads()).toBe(0);
  });
});

describe("a read still running at its request's deadline", () => {
  it('answers 504 while the lock is still held, then serves the next read on a fresh thread', async () => {
    // No hippo.db at boot, so the server holds no connection and another one can lock the whole file.
    const root = removeLater(mkdtempSync(join(tmpdir(), 'hippo-store-deadlines-bare-')));
    const executor = createSqliteExecutor(root, { busyWaitMs: LONG_WAIT_MS });
    const server = await start(root, { store: workerSqliteStore(root, executor) });
    const before = await counts(server);
    mkdirSync(join(root, '.hippo'), { recursive: true });
    initStore(root);
    // The setup runs on the writer before any read. It is asked of the executor, since after any response the server would hold a connection, as the idle writer would.
    await executor.call('readiness.ping', [], { mode: 'write', requestId: undefined });
    executor.terminateWriter();
    while (executor.liveThreads() > 0) await new Promise((resolve) => setImmediate(resolve));
    const other = new DatabaseSync(getHippoDbPath(root));
    cleanups.push(() => {
      if (other.isOpen !== false) other.close();
    });
    other.exec('PRAGMA locking_mode = EXCLUSIVE');
    other.exec('BEGIN EXCLUSIVE');

    deadline(SHORT_DEADLINE_MS);
    const late = await get(server, '/v1/predictions');

    await expectDeadlineReply(late, 'did not answer the read');
    deadline('0');
    other.exec('COMMIT');
    other.close();
    expect((await get(server, '/v1/predictions')).status).toBe(200);
    // The stopped thread exits once its statement has met the freed lock; each look is a round trip, never a pause.
    let after = await counts(server);
    while (after.store_workers_replaced === before.store_workers_replaced) after = await counts(server);
    expect([after.store_workers_replaced, after.store_jobs_expired]).toEqual([before.store_workers_replaced + 1, before.store_jobs_expired + 1]);
    expect((await Promise.all([get(server, '/v1/predictions'), get(server, '/v1/predictions')])).map((res) => res.status)).toEqual([200, 200]);
  });
});

describe("a write still running at its request's deadline", () => {
  it('before it could commit: stops the thread, answers 504 only once the thread has exited, saves nothing, and the next write lands', async () => {
    const root = newRoot();
    deadline('0');
    const { store } = patientStore(root, { writeGraceMs: LONG_WAIT_MS });
    const server = await start(root, { store });
    expect((await save(server, 'warms the writer')).status).toBe(201);
    const before = await counts(server);
    const lock = holdWriteLock(root);
    const expired = logged('warn', PAST_DEADLINE);
    const order: string[] = [];

    deadline(SHORT_DEADLINE_MS);
    const write = save(server, 'stopped before its commit').then((res) => {
      order.push('write');
      return res;
    });
    await expired;
    await counts(server);
    order.push('health');
    deadline('0');
    lock.release();

    await expectDeadlineReply(await write, 'nothing was saved');
    expect(order).toEqual(['health', 'write']);
    expect((await save(server, 'after the replacement')).status).toBe(201);
    expect(claims(root)).toEqual(['warms the writer', 'after the replacement']);
    expect((await counts(server)).store_workers_replaced).toBe(before.store_workers_replaced + 1);
  });

  it('after it may have committed: leaves the thread running and answers 504 with the outcome unknown once the grace has passed', async () => {
    const root = newRoot();
    deadline('0');
    const { store } = patientStore(root, { writeGraceMs: 1 });
    const server = await start(root, { store });
    expect((await save(server, 'warms the writer')).status).toBe(201);
    const before = await counts(server);
    const lock = holdWriteLock(root);

    deadline(SHORT_DEADLINE_MS);
    const late = await get(server, '/v1/predictions/stats?class=release');

    await expectDeadlineReply(late, 'may or may not be saved');
    deadline('0');
    lock.release();
    expect((await save(server, 'on the same thread')).status).toBe(201);
    expect(auditOps(root).filter((op) => op === 'predict_baserate')).toHaveLength(1);
    expect((await counts(server)).store_workers_replaced).toBe(before.store_workers_replaced);
  });

  it('after it may have committed: answers as usual when the write finishes within the grace', async () => {
    const root = newRoot();
    deadline('0');
    const { store } = patientStore(root, { writeGraceMs: LONG_WAIT_MS });
    const server = await start(root, { store });
    expect((await save(server, 'warms the writer')).status).toBe(201);
    const lock = holdWriteLock(root);
    const expired = logged('warn', PAST_DEADLINE);

    deadline(SHORT_DEADLINE_MS);
    const stats = get(server, '/v1/predictions/stats?class=release');
    await expired;
    lock.release();
    const res = await stats;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ baserate: { classTag: 'release', nClosed: 0 } });
    expect(auditOps(root).filter((op) => op === 'predict_baserate')).toHaveLength(1);
  });
});

describe('the handler deadline', () => {
  it('answers 504 with the request id while the handler still runs, and drops what the handler returns later', async () => {
    const root = newRoot();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let returned = (): void => {};
    const handlerDone = new Promise<void>((resolve) => { returned = resolve; });
    const routes = [{ path: '/v1/slow', handler: async () => { await gate; returned(); return { late: true }; } }];
    const server = await start(root, { routes });
    const before = await counts(server);
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const finished = loggedFields('info', LATE);

    deadline(SHORT_DEADLINE_MS);
    const late = await post(server, '/v1/slow', {});

    await expectDeadlineReply(late, 'did not finish by its deadline');
    deadline('0');
    release();
    await handlerDone;
    // A write that ends late did run, so one info line says so under the id and the route of the 504's access line.
    expect(await finished).toEqual({ requestId: late.headers.get('x-request-id'), method: 'POST', route: '/v1/slow' });
    const after = await counts(server);
    expect(after.handler_deadlines).toBe(before.handler_deadlines + 1);
    expect(errors.mock.calls.map((call) => call[0])).toEqual([expect.stringContaining('POST /v1/slow failed: the request did not finish by its deadline')]);
    expect(warns.mock.calls.filter(([message]) => message.includes(LATE))).toEqual([]);
  });

  it('logs one warn line when the handler fails after the 504, with the request id and the route and none of the error text', async () => {
    const root = newRoot();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const routes = [{ path: '/v1/slow', handler: async () => { await gate; throw new RangeError('no row for private-caller-text'); } }];
    const server = await start(root, { routes });
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});
    const warned = vi.spyOn(log, 'warn');
    const failed = new Promise<void>((resolve) => { warned.mockImplementation((message) => { if (message.includes(LATE)) resolve(); }); });

    deadline(SHORT_DEADLINE_MS);
    const late = await post(server, '/v1/slow?q=private-query', {});

    await expectDeadlineReply(late, 'did not finish by its deadline');
    deadline('0');
    release();
    await failed;
    await counts(server);
    expect(warned.mock.calls.filter(([message]) => message.includes(LATE))).toEqual([
      ['request failed after its deadline reply',
        { requestId: late.headers.get('x-request-id'), method: 'POST', route: '/v1/slow', failureStatus: 500, errorClass: 'RangeError' }],
    ]);
    expect(infos.mock.calls.filter(([message]) => message.includes(LATE))).toEqual([]);
    expect(JSON.stringify([warned.mock.calls, infos.mock.calls])).not.toContain('private-');
  });

  it('says nothing when a read finishes after its 504: nothing was written', async () => {
    const root = newRoot();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const authResolver: AuthResolver = async () => { await gate; return { tenantId: 'default', subject: 'user-1', role: 'member' }; };
    // The in-process store, since the workers refuse a call that arrives past its request's deadline and the read would fail.
    const server = await start(root, { store: sqliteStore(root), authResolver, authResolverTimeoutMs: LONG_WAIT_MS });
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});
    const warns = vi.spyOn(log, 'warn').mockImplementation(() => {});

    deadline(SHORT_DEADLINE_MS);
    const late = await fetch(`${server.url}/v1/predictions`, { headers: { ...JSON_TYPE, authorization: 'Bearer ext.reader' } });

    await expectDeadlineReply(late, 'did not finish by its deadline');
    deadline('0');
    release();
    // Two round trips give the late handler the turns it needs to end.
    expect((await get(server, '/v1/predictions')).status).toBe(200);
    await counts(server);
    expect([...infos.mock.calls, ...warns.mock.calls].filter(([message]) => message.includes(LATE))).toEqual([]);
  });

  it('is off at HIPPO_REQUEST_DEADLINE_MS=0: a write held far past the short deadline still lands', async () => {
    const root = newRoot();
    const { store, sent } = patientStore(root);
    const server = await start(root, { store });
    deadline('0');
    expect((await save(server, 'warms the writer')).status).toBe(201);
    const lock = holdWriteLock(root);
    const expired = logged('warn', PAST_DEADLINE);
    deadline(SHORT_DEADLINE_MS);
    const stopped = save(server, 'under the short deadline');
    await sent(SAVE, 2);

    deadline('0');
    const patient = save(server, 'with no deadline');
    await expired;
    lock.release();

    expect([(await stopped).status, (await patient).status]).toEqual([504, 201]);
    expect(claims(root)).toEqual(['warms the writer', 'with no deadline']);
  });
});

type Step = readonly [label: string, send: (server: ServerHandle) => Promise<Response>];

const STEPS: readonly Step[] = [
  ['create', (s) => save(s, 'ships in three days')],
  ['create without a claim', (s) => post(s, '/v1/predictions', { classTag: 'release' })],
  ['list', (s) => get(s, '/v1/predictions')],
  ['get', (s) => get(s, '/v1/predictions/1')],
  ['get a missing row', (s) => get(s, '/v1/predictions/99')],
  ['close', (s) => post(s, '/v1/predictions/1/close', { state: 'closed', actual: 5 })],
  ['close it again', (s) => post(s, '/v1/predictions/1/close', { state: 'closed', actual: 5 })],
  ['stats', (s) => get(s, '/v1/predictions/stats?class=release')],
];

const PER_REQUEST_HEADERS = new Set(['date', 'x-request-id', 'content-length']);

/** Every step's status, headers and body, less what differs between two stores by construction: generated ids and clock readings. */
async function replies(root: string, opts: Partial<ServeOpts> = {}) {
  const server = await start(root, opts);
  const seen = [];
  for (const [label, send] of STEPS) {
    const res = await send(server);
    const headers = [...res.headers].filter(([name]) => !PER_REQUEST_HEADERS.has(name)).sort();
    const body = (await res.text()).replace(/sem_[0-9a-f]+/g, '<memory>').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>');
    seen.push({ label, status: res.status, headers, body });
  }
  return seen;
}

describe('a request that finishes inside its deadline and under the queue cap', () => {
  it('gets the same status, headers and body from the workers with the deadline on, with it off, and from the in-process store', async () => {
    const inProcessRoot = newRoot();
    const inProcess = await replies(inProcessRoot, { store: sqliteStore(inProcessRoot) });
    const withDeadline = await replies(newRoot());
    deadline('0');
    const withoutDeadline = await replies(newRoot());

    expect(withDeadline).toEqual(inProcess);
    expect(withoutDeadline).toEqual(inProcess);
    expect(withDeadline.map((reply) => reply.status)).toEqual([201, 400, 200, 200, 404, 200, 400, 200]);
  });
});
