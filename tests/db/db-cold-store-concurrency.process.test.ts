// openHippoDb leaned on `PRAGMA busy_timeout` alone, which SQLite ignores for
// `PRAGMA journal_mode` and for a write upgrading a deferred read snapshot, so
// concurrent opens of a cold store died with errcode 5 / 517 (db.ts:2389,2435).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getCurrentSchemaVersion } from '../../src/db/index.js';
import { removeWhenStopped } from '../_helpers/make-root.js';
import { startNode, type StartedChild, STORE_RUN_MS, STORE_RUN_REASON } from '../_helpers/started-child.js';

let root: string;

afterEach(() => removeWhenStopped(root));

// The race only exists across processes, so the workers import the build output.
const DIST_DB = join(import.meta.dirname, '..', '..', 'dist', 'db/index.js');
const DB_URL = pathToFileURL(DIST_DB).href;
// Worker side: past the parent's 10 s wait for every ready line, so no worker gives up while the parent still waits.
const BARRIER_MS = 20_000;

// Spawn latency alone staggers the workers too far apart to collide, so each one
// prints ready, spins on a barrier file, and the parent releases them all at once.
function workerScript(hippoRoot: string, barrier: string): string {
  return `
    import { existsSync } from 'node:fs';
    import { openHippoDb, getSchemaVersion, closeHippoDb } from ${JSON.stringify(DB_URL)};
    process.stdout.write('ready\\n');
    const deadline = Date.now() + ${BARRIER_MS};
    const tick = new Int32Array(new SharedArrayBuffer(4));
    while (existsSync(${JSON.stringify(barrier)})) {
      if (Date.now() > deadline) { console.log('barrier-timeout'); process.exit(3); }
      Atomics.wait(tick, 0, 0, 1);
    }
    const db = openHippoDb(${JSON.stringify(hippoRoot)});
    const version = getSchemaVersion(db);
    closeHippoDb(db);
    console.log(String(version));
  `;
}

function startWorkers(count: number, barrier: string): StartedChild[] {
  return Array.from({ length: count }, (_, i) => {
    const file = join(root, `open-worker-${i}.mjs`);
    writeFileSync(file, workerScript(root, barrier), 'utf8');
    return startNode([file], { input: '' });
  });
}

describe('openHippoDb on a cold store under concurrent processes', () => {
  it('every process opens and migrates to the current schema version', async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-cold-open-'));
    const barrier = join(root, 'barrier');
    writeFileSync(barrier, 'x', 'utf8');

    const workers = startWorkers(8, barrier);
    try {
      // Parent side: each worker's ready line, under the event deadline.
      await Promise.all(workers.map((w, i) => w.line(/^ready$/, `worker ${i} at the barrier`)));
    } finally {
      rmSync(barrier, { force: true });
    }
    const results = (await Promise.all(workers.map((w) => w.exited(STORE_RUN_MS, STORE_RUN_REASON)))).map((r) => ({
      ...r,
      stdout: r.stdout.trim().split('\n').pop(),
    }));

    const failed = results.filter((r) => r.code !== 0);
    expect(failed.map((r) => r.stderr.split('\n').find((l) => l.includes('Error')) ?? `exit ${r.code}`)).toEqual([]);
    expect(results.map((r) => r.stdout)).toEqual(results.map(() => String(getCurrentSchemaVersion())));
    expect(existsSync(join(root, 'hippo.db'))).toBe(true);
  });
});
