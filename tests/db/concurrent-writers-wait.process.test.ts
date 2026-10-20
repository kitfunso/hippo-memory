// A deferred write scope reads before it writes, and SQLite skips the busy handler for that upgrade,
// so a second hippo process failed with `database is locked` instead of waiting for the write lock.
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeHippoDb, getHippoDbPath, openHippoDb } from '../../src/db/index.js';
import { createMemory } from '../../src/base/memory/memory.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { distUrl, withDb } from '../_helpers/agent-memories-world.js';
import { makeRoot, makeStore } from '../_helpers/make-root.js';

const WORKERS = 2;
const ROWS = 60;
// A zero-wait BEGIN IMMEDIATE on a second handle says whether another writer holds the lock as this one comes to write.
const WORKER = `
const [, , memoryUrl, writesUrl, root, dbPath, tag, rows] = process.argv;
const { DatabaseSync } = await import('node:sqlite');
const { createMemory } = await import(memoryUrl);
const { writeEntry } = await import(writesUrl);
const probe = new DatabaseSync(dbPath);
probe.exec('PRAGMA busy_timeout = 0');
let found = 'free';
try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); } catch (error) { if (error.errcode !== 5) throw error; found = 'held'; }
probe.close();
process.stdout.write(found + '\\n');
for (let i = 0; i < Number(rows); i++) {
  writeEntry(root, createMemory('Worker ' + tag + ' notes that deploy step ' + i + ' waits for the nightly backup window.', { baseHalfLifeDays: 30 }));
}
`;

interface Worker {
  /** The worker's first line: whether it found the write lock held before its first write. */
  readonly found: Promise<string>;
  readonly finished: Promise<{ readonly code: number | null; readonly stderr: string }>;
}

let root: string;

function startWorker(args: readonly string[]): Worker {
  const child = spawn(process.execPath, [join(root, 'worker.mjs'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  const found = new Promise<string>((resolve) => {
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
      if (stdout.includes('\n')) resolve(stdout.split('\n')[0]!);
    });
    child.on('close', () => resolve(stdout.split('\n')[0]!));
  });
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
  });
  const finished = new Promise<{ code: number | null; stderr: string }>((resolve, fail) => {
    child.on('error', fail);
    child.on('close', (code) => resolve({ code, stderr }));
  });
  return { found, finished };
}

interface StoreCounts {
  readonly rows: number;
  readonly audits: number;
  readonly matched: number;
}

function storeCounts(hippoRoot: string): StoreCounts {
  // SAFETY: the SELECT names exactly these three aliased COUNT columns.
  const row = withDb(hippoRoot, (db) =>
    db
      .prepare(`SELECT
    (SELECT COUNT(*) FROM memories) AS rows,
    (SELECT COUNT(*) FROM audit_log WHERE op = 'remember') AS audits,
    (SELECT COUNT(DISTINCT a.target_id) FROM audit_log a JOIN memories m ON m.id = a.target_id WHERE a.op = 'remember') AS matched`)
      .get(),
  ) as { rows: number; audits: number; matched: number };
  return { rows: Number(row.rows), audits: Number(row.audits), matched: Number(row.matched) };
}

describe('two hippo processes writing to one store at once', () => {
  it('both wait for the write lock, and every row lands with one remember audit row', async () => {
    root = makeStore('writers-wait').root;
    writeFileSync(join(root, 'worker.mjs'), WORKER, 'utf8');

    // This handle holds the write lock until every worker has met it, so all of them start writing behind one holder.
    const holder = openHippoDb(root);
    let workers: Worker[];
    try {
      holder.exec('BEGIN IMMEDIATE');
      workers = Array.from({ length: WORKERS }, (_, i) =>
        startWorker([
          distUrl('base/memory/memory.js'),
          distUrl('entry/testing.js'),
          root,
          getHippoDbPath(root),
          String(i),
          String(ROWS),
        ]),
      );
      expect(await Promise.all(workers.map((w) => w.found))).toEqual(Array(WORKERS).fill('held'));
    } finally {
      if (holder.isTransaction) holder.exec('ROLLBACK');
      closeHippoDb(holder);
    }
    const done = await Promise.all(workers.map((w) => w.finished));

    for (const d of done) expect(d.code, d.stderr).toBe(0);
    expect(storeCounts(root)).toEqual({ rows: WORKERS * ROWS, audits: WORKERS * ROWS, matched: WORKERS * ROWS });
  });
});

describe("writeEntryDbOnly inside the caller's transaction", () => {
  it("a throwing afterWrite undoes only its own row and leaves the caller's transaction open", () => {
    root = makeRoot('nested-write');
    const kept = createMemory('The caller keeps this row when a nested write fails.', { baseHalfLifeDays: 30 });
    const dropped = createMemory('This nested row rolls back on its own.', { baseHalfLifeDays: 30 });
    const db = openHippoDb(root);
    try {
      db.exec('BEGIN IMMEDIATE');
      writeEntryDbOnly(db, kept);
      expect(() =>
        writeEntryDbOnly(db, dropped, {
          afterWrite: () => {
            throw new Error('forced');
          },
        }),
      ).toThrow('forced');
      expect(db.isTransaction).toBe(true);
      db.exec('COMMIT');
    } finally {
      closeHippoDb(db);
    }
    const ids = withDb(root, (db2) =>
      db2.prepare(`SELECT id FROM memories UNION ALL SELECT target_id FROM audit_log WHERE op = 'remember'`).all(),
    );
    expect(ids).toEqual([{ id: kept.id }, { id: kept.id }]);
  });
});
