// A prompt hook has a 5 s budget, so a store held by `hippo sleep` must degrade the hook after one short wait, never stall it.
// Drives the built CLI while a child process holds the write lock.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory } from '../src/core/memory.js';
import { closeHippoDb, getHippoDbPath, openHippoDb, withSharedStoreHandles, HOOK_DB_WAIT_MS } from '../src/db/index.js';
import { lockWaitAskedMs, tracingLockWaits } from './_helpers/lock-waits.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

const LOCK_HOLDER_SRC = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
db.exec("UPDATE meta SET value = value WHERE key = 'schema_version'");
process.stdout.write('locked\\n');
setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 30000);
`;

let tmp: string;
let projectDir: string;
let localRoot: string;
let holder: ChildProcess | null = null;

function holdWriteLock(dbPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--no-warnings', '-e', LOCK_HOLDER_SRC, dbPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('locked')) resolve(child);
    });
    child.on('exit', (code) => reject(new Error(`lock holder exited early with ${code}`)));
  });
}

function runHook(args: string[], input: string) {
  const traceDir = path.join(tmp, 'lock-waits');
  const res = spawnSync(process.execPath, ['--no-warnings', HIPPO_JS, ...args], {
    env: tracingLockWaits({ ...process.env, HOME: tmp, USERPROFILE: tmp, HIPPO_HOME: path.join(tmp, 'global'), HIPPO_LOG: 'warn' }, traceDir),
    cwd: projectDir,
    input,
    encoding: 'utf8',
    timeout: 60000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, lockWaitAskedMs: lockWaitAskedMs(traceDir, res.pid) };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hook-busy-'));
  projectDir = path.join(tmp, 'proj');
  localRoot = path.join(projectDir, '.hippo');
  fs.mkdirSync(projectDir, { recursive: true });
  initStore(localRoot);
  writeEntry(localRoot, { ...createMemory('PINNED: always check the rollback plan before deploy', { baseHalfLifeDays: 30 }), pinned: true });
  writeEntry(localRoot, createMemory('the postgres migration needs a rollback plan and a dry run', { baseHalfLifeDays: 30 }));
});

afterEach(async () => {
  if (holder && holder.exitCode === null) {
    const exited = new Promise((resolve) => holder?.once('exit', resolve));
    holder.kill();
    await exited;
  }
  holder = null;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('context hook while another process holds the store write lock', () => {
  it('waits for the lock once, for the hook wait, then exits 0 with one warning', async () => {
    holder = await holdWriteLock(getHippoDbPath(localRoot));
    const payload = JSON.stringify({ session_id: 'sess-busy-1', prompt: 'postgres migration rollback plan' });

    const run = runHook(['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'], payload);

    expect(run.status).toBe(0);
    expect(run.lockWaitAskedMs).toBe(HOOK_DB_WAIT_MS);
    const warnings = run.stderr.split('\n').filter((line) => line.includes('store busy'));
    expect(warnings).toHaveLength(1);
    // WAL readers never wait on the writer, so the memories still go out; only the ledger rows are skipped.
    expect(run.stdout).toContain('rollback plan');
  }, 60000);

  it('injects as usual once the lock is gone', () => {
    const payload = JSON.stringify({ session_id: 'sess-busy-2', prompt: 'postgres migration rollback plan' });
    const run = runHook(['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'], payload);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('rollback plan');
    expect(run.stderr).not.toContain('store busy');
    expect(run.lockWaitAskedMs).toBe(0);
  }, 60000);
});

describe('lock wait per command kind', () => {
  const busyTimeout = (db: ReturnType<typeof openHippoDb>): number =>
    Number(db.prepare('PRAGMA busy_timeout').get<{ timeout: number }>().timeout);

  it('a hook scope opens with the short hook wait', async () => {
    const wait = await withSharedStoreHandles(() => {
      const db = openHippoDb(localRoot);
      const ms = busyTimeout(db);
      closeHippoDb(db);
      return ms;
    }, { busyWaitMs: HOOK_DB_WAIT_MS });
    expect(wait).toBe(HOOK_DB_WAIT_MS);
  });

  it('a non-hook open keeps the 5 s wait', () => {
    const db = openHippoDb(localRoot);
    expect(busyTimeout(db)).toBe(5000);
    closeHippoDb(db);
  });
});
