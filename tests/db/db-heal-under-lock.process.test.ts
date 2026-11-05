// An open that healed a missing table outside the write lock built the chain's indexes on a table
// another process had just made in its older shape: "no such column: owner_subject" on macOS CI.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, type DatabaseSyncLike } from '../../src/db/sqlite.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { ensureMetaTable, setSchemaVersion } from '../../src/db/meta.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/db/migrations/index.js';
import { waitFor } from '../_helpers/wait-for.js';

let root: string;
let holder: DatabaseSyncLike | undefined;
let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill();
  if (holder?.isOpen) {
    if (holder.isTransaction) holder.exec('ROLLBACK');
    holder.close();
  }
  holder = undefined;
  child = undefined;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// The race is across processes, so the opener imports the build output.
const DB_URL = pathToFileURL(join(import.meta.dirname, '..', '..', 'dist', 'db/index.js')).href;

interface Opened {
  readonly code: number | null;
  readonly stderr: string;
  readonly version?: number;
  readonly ms?: number;
}

/** Opens the store in a child that reports its schema version and how long the open waited. */
function openInChild(ready: string, busyWaitMs: number): Promise<Opened> {
  const file = join(root, 'opener.mjs');
  writeFileSync(
    file,
    `import { writeFileSync } from 'node:fs';
     import { openHippoDb, getSchemaVersion, closeHippoDb } from ${JSON.stringify(DB_URL)};
     writeFileSync(${JSON.stringify(ready)}, 'ready');
     const start = Date.now();
     const db = openHippoDb(${JSON.stringify(root)}, { busyWaitMs: ${busyWaitMs} });
     const ms = Date.now() - start;
     console.log(JSON.stringify({ version: getSchemaVersion(db), ms }));
     closeHippoDb(db);`,
    'utf8',
  );
  return new Promise((resolve) => {
    const spawned = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = spawned;
    let stdout = '';
    let stderr = '';
    spawned.stdout.on('data', (chunk) => (stdout += String(chunk)));
    spawned.stderr.on('data', (chunk) => (stderr += String(chunk)));
    spawned.on('exit', (code) => resolve(code === 0 ? { code, stderr, ...JSON.parse(stdout) } : { code, stderr }));
  });
}

const errorLines = (r: Opened): string[] => r.stderr.split('\n').filter((l) => l.includes('Error'));

describe('an open heals missing tables under the write lock', () => {
  it('waits for a migration in flight instead of indexing its older table', async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-heal-lock-'));
    holder = new DatabaseSync(join(root, 'hippo.db'));
    holder.exec('PRAGMA journal_mode = WAL');
    ensureMetaTable(holder);
    MIGRATIONS[0].up(holder, {});
    setSchemaVersion(holder, MIGRATIONS[0].version);

    // A second process is mid-way through v02: task_snapshots exists in its first shape, uncommitted.
    holder.exec('BEGIN IMMEDIATE');
    MIGRATIONS[1].up(holder, {});
    setSchemaVersion(holder, MIGRATIONS[1].version);
    const ready = join(root, 'ready');
    const opened = openInChild(ready, 5000);
    await waitFor(() => existsSync(ready), { timeoutMs: 30000, what: 'the opener to start' });
    // Long enough for the opener to read the stamp and block on the lock, well inside its 5 s wait.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    holder.exec('COMMIT');
    holder.close();

    const result = await opened;
    expect(errorLines(result)).toEqual([]);
    expect(result.version).toBe(CURRENT_SCHEMA_VERSION);
    // Proof the opener read the old stamp and waited on the lock, so the race was really run.
    expect(result.ms).toBeGreaterThanOrEqual(500);
  });

  it('opens a store with no healed table missing while another process holds the lock', async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-heal-lock-'));
    closeHippoDb(openHippoDb(root));
    holder = new DatabaseSync(join(root, 'hippo.db'));
    // A store that lost compactions stays on the slow open for good, so it must not need the lock.
    holder.exec('DROP TABLE compactions');
    holder.exec('BEGIN IMMEDIATE');

    const result = await openInChild(join(root, 'ready'), 1000);
    expect(errorLines(result)).toEqual([]);
    expect(result.version).toBe(CURRENT_SCHEMA_VERSION);
  });
});
