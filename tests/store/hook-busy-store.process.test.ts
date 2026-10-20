// A prompt hook has a 5 s budget, so a store held by `hippo sleep` must degrade the hook after one short wait, never stall it.
// Drives the built CLI while a child process holds the write lock.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { createMemory } from '../../src/base/memory/memory.js';
import {
  closeHippoDb,
  getHippoDbPath,
  openHippoDb,
  withSharedStoreHandles,
  HOOK_DB_WAIT_MS,
} from '../../src/db/index.js';
import { lockWaitAskedMs, tracingLockWaits } from '../_helpers/lock-waits.js';
import { holdStoreWriteLock, releaseStoreWriteLock } from '../_helpers/store-write-lock.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const HIPPO_JS = path.resolve(__dirname, '..', '..', 'bin', 'hippo.js');

let tmp: string;
let projectDir: string;
let localRoot: string;
let holder: ChildProcess | null = null;

function runHook(args: string[], input: string) {
  const traceDir = path.join(tmp, 'lock-waits');
  const res = spawnSync(process.execPath, ['--no-warnings', HIPPO_JS, ...args], {
    env: tracingLockWaits(
      { ...process.env, HOME: tmp, USERPROFILE: tmp, HIPPO_HOME: path.join(tmp, 'global'), HIPPO_LOG: 'warn' },
      traceDir,
    ),
    cwd: projectDir,
    input,
    encoding: 'utf8',
    timeout: 60000,
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    lockWaitAskedMs: lockWaitAskedMs(traceDir, res.pid),
  };
}

beforeEach(() => {
  tmp = makeRoot('hook-busy', { init: false });
  projectDir = path.join(tmp, 'proj');
  localRoot = path.join(projectDir, '.hippo');
  fs.mkdirSync(projectDir, { recursive: true });
  initTestStore(localRoot);
  writeEntry(localRoot, {
    ...createMemory('PINNED: always check the rollback plan before deploy', { baseHalfLifeDays: 30 }),
    pinned: true,
  });
  writeEntry(
    localRoot,
    createMemory('the postgres migration needs a rollback plan and a dry run', { baseHalfLifeDays: 30 }),
  );
});

afterEach(async () => {
  await releaseStoreWriteLock(holder);
  holder = null;
});

describe('context hook while another process holds the store write lock', () => {
  it('waits for the lock once, for the hook wait, then exits 0 with one warning', async () => {
    holder = await holdStoreWriteLock(getHippoDbPath(localRoot));
    const payload = JSON.stringify({ session_id: 'sess-busy-1', prompt: 'postgres migration rollback plan' });

    const run = runHook(
      ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'],
      payload,
    );

    expect(run.status).toBe(0);
    expect(run.lockWaitAskedMs).toBe(HOOK_DB_WAIT_MS);
    const warnings = run.stderr.split('\n').filter((line) => line.includes('store busy'));
    expect(warnings).toHaveLength(1);
    // WAL readers never wait on the writer, so the memories still go out; only the ledger rows are skipped.
    expect(run.stdout).toContain('rollback plan');
  });

  it('injects as usual once the lock is gone', () => {
    const payload = JSON.stringify({ session_id: 'sess-busy-2', prompt: 'postgres migration rollback plan' });
    const run = runHook(
      ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'],
      payload,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('rollback plan');
    expect(run.stderr).not.toContain('store busy');
    expect(run.lockWaitAskedMs).toBe(0);
  });
});

describe('lock wait per command kind', () => {
  const busyTimeout = (db: ReturnType<typeof openHippoDb>): number =>
    Number((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout);

  it('a hook scope opens with the short hook wait', async () => {
    const wait = await withSharedStoreHandles(
      () => {
        const db = openHippoDb(localRoot);
        const ms = busyTimeout(db);
        closeHippoDb(db);
        return ms;
      },
      { busyWaitMs: HOOK_DB_WAIT_MS },
    );
    expect(wait).toBe(HOOK_DB_WAIT_MS);
  });

  it('a non-hook open keeps the 5 s wait', () => {
    const db = openHippoDb(localRoot);
    expect(busyTimeout(db)).toBe(5000);
    closeHippoDb(db);
  });
});
