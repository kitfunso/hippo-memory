// openHippoDb ran journal_mode (lock-taking) before busy_timeout was set,
// so it could throw "database is locked" instantly under concurrent writes
// instead of waiting (db.ts:2366-2367 order fix).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';

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
// Each child reports the writes it committed while the go file existed, and every error, so the test sees the contention happened.
function churnScript(dbPath: string, goFile: string, stopFile: string): string {
  return `
    const { DatabaseSync } = require('node:sqlite');
    const { existsSync } = require('node:fs');
    let windowWrites = 0;
    const errors = [];
    for (let i = 0; !existsSync(${JSON.stringify(stopFile)}); i++) {
      const during = existsSync(${JSON.stringify(goFile)});
      try {
        const db = new DatabaseSync(${JSON.stringify(dbPath)});
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec("INSERT INTO meta(key, value) VALUES('churn', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
        db.close();
        if (during) windowWrites++;
      } catch (err) {
        errors.push(String(err && err.message));
      }
      if (i === 0) process.stdout.write('ready\\n');
    }
    process.stdout.write(JSON.stringify({ windowWrites, errors }) + '\\n');
  `;
}

interface ChurnReport { windowWrites: number; errors: string[] }

/** Starts a churner; `ready` resolves after its first write attempt, `report` resolves with its counts after it exits. */
function spawnChurner(dbPath: string, goFile: string, stopFile: string) {
  const child = spawn(process.execPath, ['-e', churnScript(dbPath, goFile, stopFile)], { stdio: ['ignore', 'pipe', 'inherit'] });
  churners.push(child);
  let out = '';
  let markReady = (): void => {};
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  child.stdout!.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    if (out.includes('ready\n')) markReady();
  });
  const report = new Promise<ChurnReport>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      const last = out.trim().split('\n').pop() ?? '';
      if (code !== 0 || !last.startsWith('{')) {
        reject(new Error(`churner exited ${code} with output: ${out}`));
        return;
      }
      // SAFETY: the churn script's last stdout line is the JSON.stringify of a ChurnReport.
      const parsed = JSON.parse(last) as ChurnReport;
      resolve(parsed);
    });
  });
  return { ready, report };
}

describe('openHippoDb pragma order: busy_timeout before journal_mode', () => {
  it('repeated opens survive concurrent writer churn without throwing', async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-pragma-order-'));
    closeHippoDb(openHippoDb(root));
    const dbPath = join(root, 'hippo.db');
    const goFile = join(root, 'go');
    const stopFile = join(root, 'stop');

    const started = [spawnChurner(dbPath, goFile, stopFile), spawnChurner(dbPath, goFile, stopFile)];
    await Promise.all(started.map((c) => c.ready));

    writeFileSync(goFile, '');
    const deadline = Date.now() + 2500;
    let opens = 0;
    const errors: string[] = [];
    while (Date.now() < deadline) {
      try {
        closeHippoDb(openHippoDb(root));
        opens++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    writeFileSync(stopFile, '');
    const reports = await Promise.all(started.map((c) => c.report));

    expect(opens).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    for (const report of reports) {
      expect(report.errors).toEqual([]);
      expect(report.windowWrites).toBeGreaterThan(0);
    }
  }, 15_000);
});
