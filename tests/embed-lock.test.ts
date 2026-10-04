import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'node:child_process';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { embedAll, loadEmbeddingIndex } from '../src/embeddings.js';

const KEY_ENV = 'OPENAI_API_KEY';
let root: string;
let savedKey: string | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-lock-'));
  initStore(root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'm' } }), 'utf8');
  writeEntry(root, createMemory('embed lock test memory', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
  savedKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = ['sk', 'test'].join('-');
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  fs.rmSync(root, { recursive: true, force: true });
});

// Fake timers drive the waiter's poll loop, so "it waited" is proven by poll count, not by how long a sleep ran.
async function expectWaitsUntilReleased(lockPath: string): Promise<void> {
  let released = false;
  const fetchedAfterRelease: boolean[] = [];
  fetchMock.mockImplementation(async () => {
    fetchedAfterRelease.push(released);
    return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
  });
  // Date stays real: the reused-PID check compares lock mtime against the real process.uptime().
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = embedAll(root);
  try {
    // setImmediate stays real; vi.waitFor would advance the fake clock and fire the poll before each check.
    for (let spins = 0; vi.getTimerCount() === 0; spins++) {
      if (spins > 10_000) throw new Error('embedAll never parked on its lock poll');
      await new Promise((r) => setImmediate(r));
    }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    released = true;
    fs.rmSync(lockPath, { force: true });
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
  }
  expect(await pending).toBe(1);
  expect(fetchedAfterRelease).toEqual([true]);
}

describe('embeddings.json cross-process lock', () => {
  it('breaks a lock left by a dead process and removes its own lock after', async () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(path.join(root, 'embeddings.lock'), String(deadPid));
    expect(await embedAll(root)).toBe(1);
    expect(Object.keys(loadEmbeddingIndex(root))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'embeddings.lock'))).toBe(false);
  });

  it('waits for a live holder, then writes once the lock is released', async () => {
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      const lockPath = path.join(root, 'embeddings.lock');
      fs.writeFileSync(lockPath, String(holder.pid));
      await expectWaitsUntilReleased(lockPath);
    } finally {
      holder.kill();
    }
  });

  it('breaks a lock with our PID written before this process started, which is a reused PID', async () => {
    const lockPath = path.join(root, 'embeddings.lock');
    fs.writeFileSync(lockPath, String(process.pid));
    const before = new Date(Date.now() - process.uptime() * 1000 - 60_000);
    fs.utimesSync(lockPath, before, before);
    expect(await embedAll(root)).toBe(1);
  });

  it('waits for a worker thread that shares our PID', async () => {
    const lockPath = path.join(root, 'embeddings.lock');
    fs.writeFileSync(lockPath, `${process.pid}:another-worker`);
    await expectWaitsUntilReleased(lockPath);
  });

  it('breaks a lock this module leaked instead of waiting on itself', async () => {
    const lockPath = path.join(root, 'embeddings.lock');
    let held = '';
    fetchMock.mockImplementation(async () => {
      held = fs.readFileSync(lockPath, 'utf8');
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
    });
    expect(await embedAll(root)).toBe(1);
    expect(held).toMatch(new RegExp(`^${process.pid}:.+`));
    fs.writeFileSync(lockPath, held);
    writeEntry(root, createMemory('a second memory to embed', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    expect(await embedAll(root)).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('leaves the lock alone when another writer has taken it over', async () => {
    const lockPath = path.join(root, 'embeddings.lock');
    fetchMock.mockImplementation(async () => {
      fs.writeFileSync(lockPath, '999999');
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
    });
    expect(await embedAll(root)).toBe(1);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('999999');
  });
});
