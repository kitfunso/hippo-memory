// An open that healed a missing table outside the write lock built the chain's indexes on a table
// another process had just made in its older shape: "no such column: owner_subject" on macOS CI.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from '../../src/db/sqlite.js';
import { ensureMetaTable, setSchemaVersion } from '../../src/db/meta.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/db/migrations/index.js';
import { waitFor } from '../_helpers/wait-for.js';

let root: string;

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// The race is across processes, so the opener imports the build output.
const DB_URL = pathToFileURL(join(import.meta.dirname, '..', '..', 'dist', 'db/index.js')).href;

function openInChild(ready: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const file = join(root, 'opener.mjs');
  writeFileSync(
    file,
    `import { writeFileSync } from 'node:fs';
     import { openHippoDb, getSchemaVersion, closeHippoDb } from ${JSON.stringify(DB_URL)};
     writeFileSync(${JSON.stringify(ready)}, 'ready');
     const db = openHippoDb(${JSON.stringify(root)});
     console.log(String(getSchemaVersion(db)));
     closeHippoDb(db);`,
    'utf8',
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('exit', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

describe('an open heals missing tables under the write lock', () => {
  it('waits for a migration in flight instead of indexing its older table', async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-heal-lock-'));
    const db = new DatabaseSync(join(root, 'hippo.db'));
    db.exec('PRAGMA journal_mode = WAL');
    ensureMetaTable(db);
    MIGRATIONS[0].up(db, {});
    setSchemaVersion(db, MIGRATIONS[0].version);

    // A second process is mid-way through v02: task_snapshots exists in its first shape, uncommitted.
    db.exec('BEGIN IMMEDIATE');
    MIGRATIONS[1].up(db, {});
    setSchemaVersion(db, MIGRATIONS[1].version);
    const ready = join(root, 'ready');
    const opened = openInChild(ready);
    await waitFor(() => existsSync(ready), { timeoutMs: 30000, what: 'the opener to start' });
    // Long enough for the opener to read the stamp and block on the lock, well inside its 5 s wait.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    db.exec('COMMIT');
    db.close();

    const result = await opened;
    expect(result.stderr.split('\n').filter((l) => l.includes('Error'))).toEqual([]);
    expect(result.stdout).toBe(String(CURRENT_SCHEMA_VERSION));
  });
});
