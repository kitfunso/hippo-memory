// openHippoDb ran journal_mode (lock-taking) before busy_timeout was set,
// so it could throw "database is locked" instantly under concurrent writes
// instead of waiting (db.ts:2366-2367 order fix).
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { startNode } from '../_helpers/started-child.js';

let root: string;

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
  const child = startNode(['-e', churnScript(dbPath, goFile, stopFile)], { input: '' });
  const ready = child.line(/^ready$/, 'the churner ready line');
  const wrote = child.line(/^wrote$/, 'the churner wrote line');
  const report = child.exited().then(({ code, stdout }) => {
    const last = stdout.trim().split('\n').pop() ?? '';
    if (code !== 0 || !last.startsWith('{')) throw new Error(`churner exited ${code} with output: ${stdout}`);
    // SAFETY: the churn script's last stdout line is the JSON.stringify of a ChurnReport.
    return JSON.parse(last) as ChurnReport;
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
    let settled = false;
    const allWrote = Promise.all(started.map((c) => c.wrote)).finally(() => {
      settled = true;
    });
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
    } while (!settled);
    writeFileSync(stopFile, '');
    await allWrote;
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
