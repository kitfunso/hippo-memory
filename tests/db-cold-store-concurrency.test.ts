// openHippoDb leaned on `PRAGMA busy_timeout` alone, which SQLite ignores for
// `PRAGMA journal_mode` and for a write upgrading a deferred read snapshot, so
// concurrent opens of a cold store died with errcode 5 / 517 (db.ts:2389,2435).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getCurrentSchemaVersion } from '../src/db.js';

let root: string;

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup only
  }
});

// The race only exists across processes, so the workers import the build output.
// Nothing in `npx vitest run` builds it, so check rather than trust.
const SRC_DB = join(import.meta.dirname, '..', 'src', 'db.ts');
const DIST_DB = join(import.meta.dirname, '..', 'dist', 'db.js');
const DB_URL = pathToFileURL(DIST_DB).href;

function assertFreshBuild(): void {
  let distMtime: number;
  try {
    distMtime = statSync(DIST_DB).mtimeMs;
  } catch {
    throw new Error(`${DIST_DB} is missing. Run \`npm run build\` before this test.`);
  }
  if (statSync(SRC_DB).mtimeMs > distMtime) {
    throw new Error(`${DIST_DB} is older than ${SRC_DB}. Run \`npm run build\`; this test spawns processes that import the build output, so a stale dist would test old code.`);
  }
}

// Spawn latency alone staggers the workers too far apart to collide, so they
// spin on a barrier file and the parent releases them all at once.
function workerScript(hippoRoot: string, barrier: string): string {
  return `
    import { existsSync } from 'node:fs';
    import { openHippoDb, getSchemaVersion, closeHippoDb } from ${JSON.stringify(DB_URL)};
    const deadline = Date.now() + 30000;
    while (existsSync(${JSON.stringify(barrier)})) {
      if (Date.now() > deadline) { console.log('barrier-timeout'); process.exit(3); }
    }
    const db = openHippoDb(${JSON.stringify(hippoRoot)});
    const version = getSchemaVersion(db);
    closeHippoDb(db);
    console.log(String(version));
  `;
}

function runWorkers(count: number, barrier: string): Promise<Array<{ code: number | null; stdout: string; stderr: string }>> {
  const children = [];
  for (let i = 0; i < count; i++) {
    const file = join(root, `open-worker-${i}.mjs`);
    writeFileSync(file, workerScript(root, barrier), 'utf8');
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
    assertFreshBuild();
    root = mkdtempSync(join(tmpdir(), 'hippo-cold-open-'));
    const barrier = join(root, 'barrier');
    writeFileSync(barrier, 'x', 'utf8');

    const pending = runWorkers(8, barrier);
    await new Promise((resolve) => setTimeout(resolve, 400));
    rmSync(barrier);
    const results = await pending;

    const failed = results.filter((r) => r.code !== 0);
    expect(failed.map((r) => r.stderr.split('\n').find((l) => l.includes('Error')) ?? `exit ${r.code}`)).toEqual([]);
    expect(results.map((r) => r.stdout)).toEqual(results.map(() => String(getCurrentSchemaVersion())));
    expect(existsSync(join(root, 'hippo.db'))).toBe(true);
  }, 120000);
});
