// A deferred write scope reads before it writes, and SQLite skips the busy handler for that upgrade,
// so a second hippo process failed with `database is locked` instead of waiting for the write lock.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { createMemory } from '../src/core/memory.js';
import { writeEntryDbOnly } from '../src/store/entry-writes.js';
import { initStore } from '../src/store/open.js';
import { distUrl, withDb } from './_helpers/agent-memories-world.js';

const WORKERS = 2;
const ROWS = 60;
const WORKER = `
const [, , memoryUrl, writesUrl, root, tag, rows, startAt] = process.argv;
const { createMemory } = await import(memoryUrl);
const { writeEntry } = await import(writesUrl);
await new Promise((done) => setTimeout(done, Math.max(0, Number(startAt) - Date.now())));
for (let i = 0; i < Number(rows); i++) {
  writeEntry(root, createMemory('Worker ' + tag + ' notes that deploy step ' + i + ' waits for the nightly backup window.', { baseHalfLifeDays: 30 }));
}
`;

interface Finished {
  readonly code: number | null;
  readonly stderr: string;
}

let root: string;

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function runWorker(args: readonly string[]): Promise<Finished> {
  return new Promise((resolve, fail) => {
    const child = spawn(process.execPath, [join(root, 'worker.mjs'), ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', fail);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

interface StoreCounts {
  readonly rows: number;
  readonly audits: number;
  readonly matched: number;
}

function storeCounts(hippoRoot: string): StoreCounts {
  // SAFETY: the SELECT names exactly these three aliased COUNT columns.
  const row = withDb(hippoRoot, (db) => db.prepare(`SELECT
    (SELECT COUNT(*) FROM memories) AS rows,
    (SELECT COUNT(*) FROM audit_log WHERE op = 'remember') AS audits,
    (SELECT COUNT(DISTINCT a.target_id) FROM audit_log a JOIN memories m ON m.id = a.target_id WHERE a.op = 'remember') AS matched`).get()) as StoreCounts;
  return { rows: Number(row.rows), audits: Number(row.audits), matched: Number(row.matched) };
}

describe('two hippo processes writing to one store at once', () => {
  it('both wait for the write lock, and every row lands with one remember audit row', async () => {
    root = join(mkdtempSync(join(tmpdir(), 'hippo-writers-wait-')), '.hippo');
    initStore(root);
    writeFileSync(join(root, 'worker.mjs'), WORKER, 'utf8');

    // Every worker waits for one shared start time after loading, so the writes overlap.
    const startAt = String(Date.now() + 2000);
    const done = await Promise.all(Array.from({ length: WORKERS }, (_, i) =>
      runWorker([distUrl('core/memory.js'), distUrl('store/entry-writes.js'), root, String(i), String(ROWS), startAt])));

    for (const d of done) expect(d.code, d.stderr).toBe(0);
    expect(storeCounts(root)).toEqual({ rows: WORKERS * ROWS, audits: WORKERS * ROWS, matched: WORKERS * ROWS });
  }, 60_000);
});

describe('writeEntryDbOnly inside the caller\'s transaction', () => {
  it('a throwing afterWrite undoes only its own row and leaves the caller\'s transaction open', () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-nested-write-'));
    initStore(root);
    const kept = createMemory('The caller keeps this row when a nested write fails.', { baseHalfLifeDays: 30 });
    const dropped = createMemory('This nested row rolls back on its own.', { baseHalfLifeDays: 30 });
    const db = openHippoDb(root);
    try {
      db.exec('BEGIN IMMEDIATE');
      writeEntryDbOnly(db, kept);
      expect(() => writeEntryDbOnly(db, dropped, { afterWrite: () => { throw new Error('forced'); } })).toThrow('forced');
      expect(db.isTransaction).toBe(true);
      db.exec('COMMIT');
    } finally {
      closeHippoDb(db);
    }
    const ids = withDb(root, (db2) => db2.prepare(`SELECT id FROM memories UNION ALL SELECT target_id FROM audit_log WHERE op = 'remember'`).all());
    expect(ids).toEqual([{ id: kept.id }, { id: kept.id }]);
  });
});
