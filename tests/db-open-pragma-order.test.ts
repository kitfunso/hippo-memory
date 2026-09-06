// openHippoDb ran journal_mode (lock-taking) before busy_timeout was set,
// so it could throw "database is locked" instantly under concurrent writes
// instead of waiting (db.ts:2366-2367 order fix).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { openHippoDb, closeHippoDb } from '../src/db.js';

let root: string;
let churners: ChildProcess[] = [];

afterEach(() => {
  for (const c of churners) c.kill();
  churners = [];
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup only
  }
});

// Pure open/close pragma churn on an already-WAL store takes no lock at all
// (each pragma is a no-op or connection-local); a real INSERT is what puts
// a RESERVED lock under the foreground open's own pragma sequence.
function churnScript(dbPath: string, durationMs: number): string {
  return `
    const { DatabaseSync } = require('node:sqlite');
    const deadline = Date.now() + ${durationMs};
    while (Date.now() < deadline) {
      try {
        const db = new DatabaseSync(${JSON.stringify(dbPath)});
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec("INSERT INTO meta(key, value) VALUES('churn', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
        db.close();
      } catch {}
    }
  `;
}

function spawnChurner(dbPath: string, durationMs: number): ChildProcess {
  return spawn(process.execPath, ['-e', churnScript(dbPath, durationMs)], { stdio: 'ignore' });
}

describe('openHippoDb pragma order: busy_timeout before journal_mode', () => {
  it('repeated opens survive concurrent writer churn without throwing', async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-pragma-order-'));
    closeHippoDb(openHippoDb(root));
    const dbPath = join(root, 'hippo.db');

    const durationMs = 2500;
    churners = [spawnChurner(dbPath, durationMs), spawnChurner(dbPath, durationMs)];

    const deadline = Date.now() + durationMs;
    let opens = 0;
    const errors: string[] = [];
    while (Date.now() < deadline) {
      try {
        closeHippoDb(openHippoDb(root));
        opens++;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }

    expect(opens).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  }, 15_000);
});
