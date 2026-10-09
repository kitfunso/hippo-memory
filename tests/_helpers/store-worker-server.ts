// A real server on a real store, on store workers or in process, for the tests that compare the two.
import { vi } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createApiKey } from '../../src/store/auth.js';
import { closeHippoDb, getHippoDbPath, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import type { JsonValue } from '../../src/util/json.js';
import { serve, type ServeOpts, type ServerHandle } from '../../src/server.js';
import type { HippoStore } from '../../src/store/index.js';
import { type CallOptions, createSqliteExecutor, type ExecutorOptions, type SqliteExecutor } from '../../src/store/sqlite/executor.js';
import { workerSqliteStore } from '../../src/store/sqlite/worker-store.js';
import { makeRoot } from './make-root.js';

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSyncLike };

// Far past any test's own timeout, so a write behind a held lock can only end when the test releases the lock or stops the thread.
const LONG_WAIT_MS = 60_000;

type Cleanup = () => Promise<void> | void;
export const cleanups: Cleanup[] = [];

/** For a test file's afterEach: restores mocks and env, then runs the cleanups newest first. */
export async function undoAll(): Promise<void> {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const undo of cleanups.splice(0).reverse()) await undo();
}

export function removeLater(root: string): string {
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

export function newRoot(label = 'sqlite-executor'): string {
  return removeLater(makeRoot(label));
}

/** A server on `root`: on the default store when `store` is absent, which is the worker-backed one. */
export async function start(root: string, store?: HippoStore, extra: Partial<ServeOpts> = {}): Promise<ServerHandle> {
  vi.stubEnv('HIPPO_V1_RPS', '0');
  const server = await serve(store ? { hippoRoot: root, port: 0, store, ...extra } : { hippoRoot: root, port: 0, ...extra });
  cleanups.push(async () => {
    await server.stop();
    await store?.close();
  });
  return server;
}

/** A second connection, as another process would hold, with the write lock taken until `release`. */
export function holdWriteLock(root: string) {
  const other = new DatabaseSync(getHippoDbPath(root));
  cleanups.push(() => {
    if (other.isOpen !== false) other.close();
  });
  other.exec('BEGIN IMMEDIATE');
  return { release: () => other.exec('COMMIT') };
}

/** Runs `use` on a connection of the test's own, closed before it returns. */
export function onDb<T>(root: string, use: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return use(db);
  } finally {
    closeHippoDb(db);
  }
}

export function execOn(root: string, sql: string): void {
  onDb(root, (db) => db.exec(sql));
}

export function keyFor(root: string, tenantId: string, opts: { readonly role?: 'admin' | 'member'; readonly expiresAt?: string } = {}): { keyId: string; plaintext: string } {
  return onDb(root, (db) => createApiKey(db, { tenantId, label: `executor-${tenantId}`, role: 'admin', ...opts }));
}

export const jsonHeaders = (token?: string): Record<string, string> =>
  token === undefined ? { 'content-type': 'application/json' } : { 'content-type': 'application/json', authorization: `Bearer ${token}` };

export function postText(server: ServerHandle, path: string, body: string, token?: string): Promise<Response> {
  return fetch(`${server.url}${path}`, { method: 'POST', headers: jsonHeaders(token), body });
}

export const post = (server: ServerHandle, path: string, body: JsonValue, token?: string): Promise<Response> => postText(server, path, JSON.stringify(body), token);

export function get(server: ServerHandle, path: string, token?: string): Promise<Response> {
  return fetch(`${server.url}${path}`, { headers: jsonHeaders(token) });
}

export function del(server: ServerHandle, path: string, token?: string): Promise<Response> {
  return fetch(`${server.url}${path}`, { method: 'DELETE', headers: jsonHeaders(token) });
}

export async function auditFailures(server: ServerHandle): Promise<number> {
  // SAFETY: the loopback /health body carries the count as a number; the assertions on it would fail on anything else.
  const body = (await (await get(server, '/health')).json()) as { audit_write_failures: number };
  return body.audit_write_failures;
}

/** The real executor, the ops handed to it in order, and a promise that settles once an op has been handed to it a given number of times. */
export function watched(inner: SqliteExecutor) {
  const ops: string[] = [];
  const checks: Array<() => void> = [];
  const executor: SqliteExecutor = {
    call: <T>(op: string, args: readonly unknown[], opts: CallOptions) => {
      const result = inner.call<T>(op, args, opts);
      ops.push(op);
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
        if (ops.filter((name) => name === op).length >= times) resolve();
      };
      checks.push(check);
      check();
    });
  return { executor, ops, sent };
}

/** A worker-backed store whose threads wait on the write lock for as long as the test holds it. */
export function patientStore(root: string, opts: ExecutorOptions = {}) {
  const { executor, ops, sent } = watched(createSqliteExecutor(root, { busyWaitMs: LONG_WAIT_MS, ...opts }));
  return { executor, ops, sent, store: workerSqliteStore(root, executor) };
}

/** What differs between two stores by construction: generated ids, key ids and secrets, clock readings, and what is computed from a clock reading. */
export function scrub(text: string, keyIds: readonly string[] = []): string {
  const withoutKeys = keyIds.reduce((soFar, keyId, index) => soFar.replaceAll(keyId, `<key ${index}>`), text);
  return withoutKeys
    .replace(/hk_[a-z0-9]{8,}(\.[a-z0-9]+)?/g, '<minted key>')
    .replace(/(sem|mem)_[0-9a-f]+/g, '<memory>')
    .replace(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g, '<time>')
    .replace(/"next_cursor":"[^"]+"/g, '"next_cursor":"<cursor>"')
    .replace(/^strength: [\d.e-]+$/gm, 'strength: <number>')
    .replace(/"strength":[\d.e-]+/g, '"strength":"<number>"');
}

const PER_REQUEST_HEADERS = new Set(['date', 'x-request-id', 'content-length']);

export async function seen(label: string, res: Response, keyIds: readonly string[] = []) {
  const kept = [...res.headers].filter(([name]) => !PER_REQUEST_HEADERS.has(name));
  // The page cursor encodes a clock reading and a row id.
  const headers = kept.map(([name, value]) => [name, name === 'x-next-cursor' ? '<cursor>' : value]).sort();
  return { label, status: res.status, headers, body: scrub(await res.text(), keyIds) };
}

export function auditRows(root: string, keyIds: readonly string[]): string[] {
  const rows = onDb(root, (db) => db.prepare('SELECT tenant_id, actor, op, target_id, metadata_json FROM audit_log ORDER BY id').all());
  return rows.map((row) => scrub(JSON.stringify(row), keyIds));
}

/** Every markdown mirror and the stats mirror under `root`, as path and text. */
export function mirrorFiles(root: string): string[] {
  const names = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.md') || name.endsWith('stats.json'));
  return names.map((name) => scrub(`${name}\n${readFileSync(join(root, name), 'utf8')}`)).sort();
}
