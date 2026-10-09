// A running server keeps one store connection open, so a request's own close is never SQLite's last-connection close.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { initStore } from '../src/store/open.js';
import { serve, type ServerHandle } from '../src/server.js';
import { readyProbeFor } from '../src/server/ready.js';
import { sqliteStore } from '../src/store-port.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function post(handle: ServerHandle, content: string): Promise<number> {
  const res = await fetch(`${handle.url}/v1/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ content, kind: 'distilled' }),
  });
  await res.text();
  return res.status;
}

// Read from SQLite, so the test holds no copy of the limit a connection outside a server gets.
function inlineCheckpointPages(root: string): number {
  const db = openHippoDb(root);
  try {
    return Object.values(db.prepare('PRAGMA wal_autocheckpoint').get<Record<string, number>>())[0]!;
  } finally {
    closeHippoDb(db);
  }
}

describe('hippo serve store connection', () => {
  it('keeps the WAL between requests while running, and releases the store on stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-srv-conn-'));
    dirs.push(root);
    initStore(root);
    const wal = join(root, 'hippo.db-wal');
    const handle = await serve({ hippoRoot: root, port: 0 });
    try {
      expect(await post(handle, 'the staging queue drains at midnight')).toBe(200);
      // Without a held connection each request's close is the last one, which checkpoints and deletes the WAL.
      expect(existsSync(wal)).toBe(true);
      expect(await post(handle, 'the release branch is cut on Thursdays')).toBe(200);
      expect(existsSync(wal)).toBe(true);
    } finally {
      await handle.stop();
    }
    expect(existsSync(wal)).toBe(false);
  });

  it('holds the store a first write creates, and never creates one on its own', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-srv-conn-fresh-'));
    dirs.push(root);
    const handle = await serve({ hippoRoot: root, port: 0 });
    try {
      expect(existsSync(join(root, 'hippo.db'))).toBe(false);
      expect(await post(handle, 'the staging queue drains at midnight')).toBe(200);
      expect(await post(handle, 'the release branch is cut on Thursdays')).toBe(200);
      expect(existsSync(join(root, 'hippo.db-wal'))).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('checkpoints the WAL away from request commits, and gives the inline limit back on stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-srv-conn-ckpt-'));
    dirs.push(root);
    initStore(root);
    const db = join(root, 'hippo.db');
    const inlineLimit = inlineCheckpointPages(root);
    const handle = await serve({ hippoRoot: root, port: 0, rateLimits: { perAddress: 'off' } });
    try {
      const before = readFileSync(db);
      // Too few responses for a background checkpoint to be due, so a changed hippo.db could only come from a request's own commit.
      for (let n = 0; n < 16; n++) expect(await post(handle, `runbook step ${n} ${'x'.repeat(2000)}`)).toBe(200);
      expect(statSync(`${db}-wal`).size / 4096).toBeGreaterThan(2 * inlineLimit);
      expect(readFileSync(db).equals(before)).toBe(true);
      for (let n = 16; n < 80; n++) expect(await post(handle, `runbook step ${n}`)).toBe(200);
      await expect.poll(() => readFileSync(db).equals(before), { timeout: 20_000 }).toBe(false);
    } finally {
      await handle.stop();
    }
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(inlineCheckpointPages(root)).toBe(inlineLimit);
  });

  it('stops waiting for a locked store after the server lock wait, instead of stalling the event loop until the lock goes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-srv-conn-locked-'));
    dirs.push(root);
    initStore(root);
    // Another process holds an exclusive lock for 6 s; in rollback-journal mode that blocks the journal-mode switch every open makes.
    const script = join(root, 'hold-lock.mjs');
    writeFileSync(script, [
      "import { DatabaseSync } from 'node:sqlite';",
      'const db = new DatabaseSync(process.argv[2]);',
      "db.exec('PRAGMA journal_mode = DELETE');",
      "db.exec('BEGIN EXCLUSIVE');",
      "console.log('locked');",
      "setTimeout(() => { db.exec('COMMIT'); db.close(); }, 6000);",
    ].join('\n'));
    const holder = spawn(process.execPath, ['--no-warnings', script, join(root, 'hippo.db')], { stdio: ['ignore', 'pipe', 'inherit'] });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let handle: ServerHandle | undefined;
    try {
      await new Promise<void>((ok) => holder.stdout.once('data', () => ok()));
      handle = await serve({ hippoRoot: root, port: 0 });
      // The lock is still held, so only an open that gave up early can have logged this by now.
      const gaveUp = stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('could not hold a store connection'));
      expect(gaveUp).toHaveLength(1);
      expect(holder.exitCode).toBeNull();
    } finally {
      stderrSpy.mockRestore();
      const gone = new Promise((ok) => holder.once('exit', ok));
      holder.kill();
      await gone;
      await handle?.stop();
    }
  }, 60_000);
});

describe('GET /ready', () => {
  async function ready(handle: ServerHandle, method = 'GET'): Promise<{ status: number; body: string }> {
    const res = await fetch(`${handle.url}/ready`, { method, headers: { connection: 'close' } });
    return { status: res.status, body: await res.text() };
  }

  it('answers 200 once the served store answers a read, and never creates a store to find out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-srv-ready-'));
    dirs.push(root);
    const handle = await serve({ hippoRoot: root, port: 0 });
    try {
      expect(await ready(handle)).toEqual({ status: 200, body: '{"ok":true}' });
      expect(existsSync(join(root, 'hippo.db'))).toBe(false);
      expect(await post(handle, 'the staging queue drains at midnight')).toBe(200);
      expect(await ready(handle)).toEqual({ status: 200, body: '{"ok":true}' });
      expect((await ready(handle, 'POST')).status).toBe(404);
    } finally {
      await handle.stop();
    }
  });

  it('runs one store read for any number of calls in the window, and a broken store flips the answer after it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-srv-ready-window-'));
    dirs.push(root);
    initStore(root);
    const store = sqliteStore(root);
    const real = store.readiness!;
    const WINDOW_MS = 1000;
    let reads = 0;
    let clock = 5_000;
    const probe = readyProbeFor(store, { ping: () => { reads += 1; return real.ping(); } }, () => clock);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const first = await Promise.all(Array.from({ length: 50 }, () => probe()));
      expect(first.every(Boolean)).toBe(true);
      expect(reads).toBe(1);
      writeFileSync(join(root, 'hippo.db'), 'this file is not a database. '.repeat(400));
      clock += WINDOW_MS - 1;
      expect(await probe()).toBe(true);
      expect(reads).toBe(1);
      clock += 1;
      const after = await Promise.all(Array.from({ length: 50 }, () => probe()));
      expect(after.some(Boolean)).toBe(false);
      expect(reads).toBe(2);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('answers 200 with store "unchecked" for a served store that has no readiness group', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-srv-ready-unchecked-'));
    dirs.push(root);
    initStore(root);
    const handle = await serve({ hippoRoot: root, port: 0, store: { ...sqliteStore(root), readiness: undefined } });
    try {
      expect(await ready(handle)).toEqual({ status: 200, body: '{"ok":true,"store":"unchecked"}' });
    } finally {
      await handle.stop();
    }
  });

  it('answers 503 store_unavailable and warns with the error class when hippo.db is not a database, while /health stays 200', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-srv-ready-broken-'));
    dirs.push(root);
    writeFileSync(join(root, 'hippo.db'), 'this file is not a database. '.repeat(400));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const handle = await serve({ hippoRoot: root, port: 0 });
    try {
      expect(await ready(handle)).toEqual({ status: 503, body: '{"ok":false,"error":"store_unavailable"}' });
      const warned = stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('GET /ready'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/^\[hippo\] warn: GET \/ready: the store did not answer: .* ts=\S+ requestId=\S+ errorClass=\w+ stack=\S/);
      expect((await fetch(`${handle.url}/health`)).status).toBe(200);
    } finally {
      stderrSpy.mockRestore();
      await handle.stop();
    }
  });
});
