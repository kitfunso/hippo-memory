// withTrialScope undoes every write; withWriteScope's busyWaitMs reaches the lock wait. Real SQLite; the lock holder is a child process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb, withReadSnapshot, withTrialScope, withWriteScope, type DatabaseSyncLike } from '../src/db/index.js';
import { DEFAULT_BUSY_WAIT_MS } from '../src/db/busy.js';
import { makeRoot } from './_helpers/make-root.js';

let root: string;

beforeEach(() => { root = makeRoot('trial-scope'); });
afterEach(async () => {
  await holder;
  holder = null;
  fs.rmSync(root, { recursive: true, force: true });
});

function metaCount(db: DatabaseSyncLike, key: string): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM meta WHERE key = ?').get<{ n: number | bigint }>(key)?.n ?? -1);
}

function put(db: DatabaseSyncLike, key: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(key, 'v');
}

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try { return fn(db); } finally { closeHippoDb(db); }
}

describe('withTrialScope', () => {
  it('leaves no write behind after a normal return, and hands back the result', () => {
    withDb((db) => {
      expect(withTrialScope(db, 'trial', () => { put(db, 'trial_key'); return 7; })).toBe(7);
      expect(db.isTransaction).toBe(false);
      expect(metaCount(db, 'trial_key')).toBe(0);
    });
  });

  it('leaves no write behind after a throw, and rethrows the original error', () => {
    withDb((db) => {
      expect(() => withTrialScope(db, 'trial', () => { put(db, 'trial_key'); throw new Error('boom'); })).toThrow('boom');
      expect(db.isTransaction).toBe(false);
      expect(metaCount(db, 'trial_key')).toBe(0);
    });
  });

  it('inside a write scope keeps the outer writes and drops the trial writes', () => {
    withDb((db) => {
      withWriteScope(db, 'outer', () => {
        put(db, 'outer_key');
        withTrialScope(db, 'trial', () => { put(db, 'trial_key'); });
      });
      expect(metaCount(db, 'outer_key')).toBe(1);
      expect(metaCount(db, 'trial_key')).toBe(0);
    });
  });
});

const HOLDER = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
db.exec('BEGIN IMMEDIATE');
process.stdout.write('held');
setTimeout(() => { db.exec('COMMIT'); db.close(); }, Number(process.argv[3]));
`;

let holder: Promise<void> | null = null;

async function holdWriteLock(holdMs: number): Promise<void> {
  const script = path.join(root, 'holder.cjs');
  fs.writeFileSync(script, HOLDER);
  const child = spawn(process.execPath, [script, path.join(root, 'hippo.db'), String(holdMs)], { stdio: ['ignore', 'pipe', 'inherit'] });
  holder = new Promise<void>((resolve) => { child.on('close', () => resolve()); });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.stdout.once('data', () => resolve());
  });
}

describe('withWriteScope busyWaitMs', () => {
  it('waits out a lock held for a while when given a longer wait', async () => {
    const db = openHippoDb(root);
    try {
      db.exec('PRAGMA busy_timeout = 0');
      await holdWriteLock(600);
      withWriteScope(db, 'waits', () => { put(db, 'waited_key'); }, { busyWaitMs: 10000 });
      expect(metaCount(db, 'waited_key')).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('with no wait named, gives up once its clock passes DEFAULT_BUSY_WAIT_MS, the busy_timeout an open sets', async () => {
    const db = openHippoDb(root);
    let clock = 1_000_000;
    let waits = 0;
    try {
      expect(db.prepare('PRAGMA busy_timeout').get<{ timeout: number }>()?.timeout).toBe(DEFAULT_BUSY_WAIT_MS);
      db.exec('PRAGMA busy_timeout = 0');
      await holdWriteLock(1500);
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      vi.spyOn(Atomics, 'wait').mockImplementation(() => { waits += 1; clock += 100; return 'timed-out'; });
      expect(() => withWriteScope(db, 'default_wait', () => { put(db, 'default_key'); }, {})).toThrow(/locked|busy/i);
      expect(waits).toBe(DEFAULT_BUSY_WAIT_MS / 100);
    } finally {
      vi.restoreAllMocks();
      closeHippoDb(db);
    }
  });

  it('throws busy when the wait is 1 ms', async () => {
    const db = openHippoDb(root);
    try {
      db.exec('PRAGMA busy_timeout = 0');
      await holdWriteLock(600);
      const attempt = (): void => withWriteScope(db, 'short', () => { put(db, 'short_key'); }, { busyWaitMs: 1 });
      expect(attempt).toThrow(/locked|busy/i);
      expect(db.isTransaction).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('withReadSnapshot', () => {
  it('shows the caller fn error when the commit also fails', () => {
    withDb((db) => {
      const marked = new Error('marked read failure');
      const attempt = (): void => withReadSnapshot(db, () => { db.exec('ROLLBACK'); throw marked; });
      expect(attempt).toThrow(marked);
    });
  });

  it('shows the commit error when fn returned and the commit fails', () => {
    withDb((db) => {
      const attempt = (): number => withReadSnapshot(db, () => { db.exec('ROLLBACK'); return 1; });
      expect(attempt).toThrow(/no transaction is active/i);
    });
  });
});
