// The sleep claim of a store folder, in process and on the store worker: one holder at a time, kept by the operating system,
// so it frees itself when its holder is gone and a folder that cannot keep one never stops a sleep.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Consolidation } from '../../src/base/ports/store/consolidation.js';
import { takeFileLock } from '../../src/host/file-lock.js';
import { log } from '../../src/base/util/log.js';
import { WORKER_OPS } from '../../src/store/sqlite/runtime/worker-ops.js';
import { workerSqliteStore } from '../../src/store/sqlite/runtime/worker-store.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';

const LOCK_FILE = 'sleep.lock.db';

const undo: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const run of undo.splice(0).reverse()) await run();
});

/** The store's consolidation group, its claim released and the store closed after the test. */
function groupOf(kind: 'in process' | 'on the store worker', root: string): Consolidation {
  const store = kind === 'in process' ? sqliteStore(root) : workerSqliteStore(root);
  undo.push(async () => {
    await store.consolidation.releaseSleep?.();
    await store.close();
  });
  return store.consolidation;
}

/** The lock another process would hold on the folder. */
function holdAsAnotherProcess(root: string): { release: () => void } {
  const take = takeFileLock(join(root, LOCK_FILE));
  if (take.kind !== 'taken') throw new Error(`test setup: the claim was already ${take.kind}`);
  undo.push(() => take.lock.release());
  return take.lock;
}

describe.each(['in process', 'on the store worker'] as const)('sleep claim %s', (kind) => {
  it('is taken by the first sleep, held for a second one that learns since when, and free again once released', async () => {
    const group = groupOf(kind, makeRoot('sleep-claim'));

    expect(await group.claimSleep!()).toEqual({ kind: 'taken' });
    const second = await group.claimSleep!();
    expect(second).toEqual({ kind: 'held', since: expect.any(String) });
    if (second.kind !== 'held') throw new Error(`the second claim was ${second.kind}`);
    expect(Math.abs(Date.now() - Date.parse(second.since))).toBeLessThan(60_000);

    await group.releaseSleep!();
    expect(await group.claimSleep!()).toEqual({ kind: 'taken' });
  });

  it('is held while another process holds the folder lock, and taken once that process lets go', async () => {
    const root = makeRoot('sleep-claim');
    const group = groupOf(kind, root);
    const other = holdAsAnotherProcess(root);

    expect(await group.claimSleep!()).toEqual({ kind: 'held', since: expect.any(String) });
    other.release();
    expect(await group.claimSleep!()).toEqual({ kind: 'taken' });
  });
});

describe('sleep claim on a folder that cannot keep one', () => {
  it('is taken every time and warns once for the folder in this process', async () => {
    const notAFolder = join(makeRoot('sleep-claim-file', { init: false }), 'store');
    writeFileSync(notAFolder, '');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    for (const group of [sqliteStore(notAFolder).consolidation, sqliteStore(notAFolder).consolidation]) {
      expect(await group.claimSleep!()).toEqual({ kind: 'taken' });
      expect(await group.claimSleep!()).toEqual({ kind: 'taken' });
      await group.releaseSleep!();
    }

    expect(warn.mock.calls.filter(([message]) => message.includes('sleep claim'))).toHaveLength(1);
  });
});

describe('sleep claim of a store that closes', () => {
  it('is freed when the store worker ends, so a held claim never outlives its store', async () => {
    const root = makeRoot('sleep-claim');
    const store = workerSqliteStore(root);
    expect(await store.consolidation.claimSleep!()).toEqual({ kind: 'taken' });

    await store.close();

    const take = takeFileLock(join(root, LOCK_FILE));
    expect(take.kind).toBe('taken');
    if (take.kind === 'taken') take.lock.release();
  });
});

describe('sleep claim placement', () => {
  it('runs a take and its release on the one writer thread', () => {
    expect(WORKER_OPS.consolidation).toMatchObject({ claimSleep: 'write', releaseSleep: 'write' });
  });
});
