import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { embedAll } from '../../src/domain/search/embed-memories.js';
import { localIndex } from '../_helpers/cli-stores.js';
import { takeFileLock } from '../../src/host/file-lock.js';
import { tryEmbedLock } from '../../src/store/sqlite/embed-lock.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadEmbeddingIndex } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const KEY_ENV = 'OPENAI_API_KEY';
let root: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = makeRoot('embed-lock');
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ embeddings: { provider: 'openai', model: 'm' } }),
    'utf8',
  );
  writeEntry(root, createMemory('embed lock test memory', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
  vi.stubEnv(KEY_ENV, ['sk', 'test'].join('-'));
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const HOLDER = path.join(import.meta.dirname, '..', '_helpers', 'lock-holder.mjs');
const LOCK_FILE = 'embeddings.lock.db';

/** A child process that holds the lock file until it is killed. */
async function holdInChild(lockPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [HOLDER, lockPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
  return child;
}

const kill = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    child.once('close', () => resolve());
    child.kill('SIGKILL');
  });

// Fake timers drive the waiter's poll loop, so "it waited" is proven by poll count, not by how long a sleep ran.
async function expectWaitsUntilReleased(release: () => Promise<void>): Promise<void> {
  let released = false;
  const fetchedAfterRelease: boolean[] = [];
  fetchMock.mockImplementation(async () => {
    fetchedAfterRelease.push(released);
    return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = embedAll(localIndex(root));
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
    await release();
    // The polls back off to one a second, so the next one comes within a second of the release.
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
  }
  expect(await pending).toBe(1);
  expect(fetchedAfterRelease).toEqual([true]);
}

describe('embeddings.json cross-process lock', () => {
  it('a SIGKILLed holder frees the lock, and the next run takes it', async () => {
    const lockPath = path.join(root, LOCK_FILE);
    await kill(await holdInChild(lockPath));
    expect(await embedAll(localIndex(root))).toBe(1);
    expect(Object.keys(loadEmbeddingIndex(root))).toHaveLength(1);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('waits for a live holder, then writes once the lock is released', async () => {
    const holder = await holdInChild(path.join(root, LOCK_FILE));
    try {
      await expectWaitsUntilReleased(() => kill(holder));
    } finally {
      holder.kill();
    }
  });

  it('a second take in the same thread while held is null', () => {
    const first = tryEmbedLock(root);
    expect(first).not.toBeNull();
    expect(tryEmbedLock(root)).toBeNull();
    first?.release();
    const again = tryEmbedLock(root);
    expect(again).not.toBeNull();
    again?.release();
  });

  it('a throw inside the turn still releases the lock', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('provider down');
    });
    await embedAll(localIndex(root)).catch(() => undefined);
    const take = takeFileLock(path.join(root, LOCK_FILE));
    expect(take.kind).toBe('taken');
    if (take.kind === 'taken') take.lock.release();
  });
});
