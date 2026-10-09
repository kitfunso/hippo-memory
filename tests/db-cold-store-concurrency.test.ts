// openHippoDb leaned on `PRAGMA busy_timeout` alone, which SQLite ignores for
// `PRAGMA journal_mode` and for a write upgrading a deferred read snapshot, so
// concurrent opens of a cold store died with errcode 5 / 517 (db.ts:2389,2435).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getCurrentSchemaVersion } from '../src/db/index.js';

let root: string;

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup only
  }
});

// The race only exists across processes, so the workers import the build output.
const DIST_DB = join(import.meta.dirname, '..', 'dist', 'db/index.js');
const DB_URL = pathToFileURL(DIST_DB).href;

// Spawn latency alone staggers the workers too far apart to collide, so each one
// reports ready, spins on a barrier file, and the parent releases them all at once.
function workerScript(hippoRoot: string, barrier: string, ready: string): string {
  return `
    import { existsSync, writeFileSync } from 'node:fs';
    import { openHippoDb, getSchemaVersion, closeHippoDb } from ${JSON.stringify(DB_URL)};
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    const deadline = Date.now() + 60000;
    while (existsSync(${JSON.stringify(barrier)})) {
      if (Date.now() > deadline) { console.log('barrier-timeout'); process.exit(3); }
    }
    const db = openHippoDb(${JSON.stringify(hippoRoot)});
    const version = getSchemaVersion(db);
    closeHippoDb(db);
    console.log(String(version));
  `;
}

function readyFile(i: number): string {
  return join(root, `ready-${i}`);
}

async function waitForReady(count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const missing = Array.from({ length: count }, (_, i) => i).filter((i) => !existsSync(readyFile(i)));
    if (missing.length === 0) return;
    if (Date.now() > deadline) throw new Error(`workers ${missing.join(', ')} never reached the barrier within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function runWorkers(count: number, barrier: string): Promise<Array<{ code: number | null; stdout: string; stderr: string }>> {
  const children = [];
  for (let i = 0; i < count; i++) {
    const file = join(root, `open-worker-${i}.mjs`);
    writeFileSync(file, workerScript(root, barrier, readyFile(i)), 'utf8');
    children.push(new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('exit', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
    }));
  }
  return Promise.all(children);
}

describe('openHippoDb on a cold store under concurrent processes', () => {
  it('every process opens and migrates to the current schema version', async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-cold-open-'));
    const barrier = join(root, 'barrier');
    writeFileSync(barrier, 'x', 'utf8');

    const pending = runWorkers(8, barrier);
    try {
      await waitForReady(8, 60000);
    } finally {
      rmSync(barrier, { force: true });
    }
    const results = await pending;

    const failed = results.filter((r) => r.code !== 0);
    expect(failed.map((r) => r.stderr.split('\n').find((l) => l.includes('Error')) ?? `exit ${r.code}`)).toEqual([]);
    expect(results.map((r) => r.stdout)).toEqual(results.map(() => String(getCurrentSchemaVersion())));
    expect(existsSync(join(root, 'hippo.db'))).toBe(true);
  }, 120000);
});
