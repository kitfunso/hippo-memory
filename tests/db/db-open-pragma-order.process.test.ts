// openHippoDb ran journal_mode (lock-taking) before busy_timeout was set,
// so it could throw "database is locked" instantly under concurrent writes
// instead of waiting (db.ts:2366-2367 order fix).
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';

let root: string;
let churners: ChildProcess[] = [];

afterEach(() => {
  for (const c of churners) c.kill();
  churners = [];
});

// A churner prints 'wrote' once it has committed this many beside the foreground opens, which then stop.
const WINDOW_WRITES = 25;

// Pragma-only churn on a WAL store takes no lock; a real INSERT puts a RESERVED lock under the foreground open's pragmas.
// Each child reports its writes while the go file existed, and every error, so the test sees the contention happened.
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
        if (windowWrites === ${WINDOW_WRITES}) process.stdout.write('wrote\\n');
      } catch (err) {
        errors.push(String(err && err.message));
      }
      if (i === 0) process.stdout.write('ready\\n');
    }
    process.stdout.write(JSON.stringify({ windowWrites, errors }) + '\\n');
  `;
}

interface ChurnReport {
  windowWrites: number;
  errors: string[];
}

/** Starts a churner: `ready` after its first write attempt, `wrote` once it has its window writes, `report` at exit. */
function spawnChurner(dbPath: string, goFile: string, stopFile: string) {
  const child = spawn(process.execPath, ['-e', churnScript(dbPath, goFile, stopFile)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  churners.push(child);
  let out = '';
  let markReady = (): void => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout!.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    if (out.includes('ready\n')) markReady();
  });
  const wrote = (): boolean => out.includes('wrote\n');
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
  return { ready, wrote, report };
}

describe('openHippoDb pragma order: busy_timeout before journal_mode', () => {
  it('repeated opens survive concurrent writer churn without throwing', async () => {
    root = makeRoot('pragma-order');
    closeHippoDb(openHippoDb(root));
    const dbPath = join(root, 'hippo.db');
    const goFile = join(root, 'go');
    const stopFile = join(root, 'stop');

    const started = [spawnChurner(dbPath, goFile, stopFile), spawnChurner(dbPath, goFile, stopFile)];
    await Promise.all(started.map((c) => c.ready));

    writeFileSync(goFile, '');
    let opens = 0;
    const errors: string[] = [];
    // The opens run until every churner has committed its writes beside them, so the overlap is counted, not timed.
    do {
      try {
        closeHippoDb(openHippoDb(root));
        opens++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
      // A turn of the event loop between opens, so the churners' 'wrote' lines are read.
      await new Promise((resolve) => setImmediate(resolve));
    } while (!started.every((c) => c.wrote()));
    writeFileSync(stopFile, '');
    const reports = await Promise.all(started.map((c) => c.report));

    // The open count follows the scheduler, so only the floor of one is fixed.
    expect(opens).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    for (const report of reports) {
      expect(report.errors).toEqual([]);
      expect(report.windowWrites).toBeGreaterThanOrEqual(WINDOW_WRITES);
    }
  });
});
