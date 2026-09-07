// updateStats read-modify-wrote all three meta counters with no transaction and
// wrote all three back, so concurrent writers lost increments and clobbered
// counters they had not touched (store.ts:2316 atomic-increment fix).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadStats, initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb, getMeta } from '../src/db.js';

let root: string;

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup only
  }
});

// The workers must exercise the shipped updateStats, not a copy of it, so they
// import the build output. `npm test` runs `pretest` -> `npm run build` first.
const STORE_URL = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'store.js')).href;

function workerScript(hippoRoot: string, field: string, iterations: number): string {
  return `
    import { updateStats } from ${JSON.stringify(STORE_URL)};
    for (let i = 0; i < ${iterations}; i++) {
      updateStats(${JSON.stringify(hippoRoot)}, { ${field}: 1 });
    }
  `;
}

function runWorkers(specs: ReadonlyArray<{ field: string; iterations: number }>): Promise<void[]> {
  return Promise.all(
    specs.map((spec, i) => {
      const file = join(root, `worker-${i}.mjs`);
      writeFileSync(file, workerScript(root, spec.field, spec.iterations), 'utf8');
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [file], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${i} exited ${code}: ${stderr}`))));
      });
    }),
  );
}

describe('updateStats under concurrent writers', () => {
  it('every increment to one counter lands', async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-stats-race-'));
    initStore(root);

    await runWorkers([
      { field: 'remembered', iterations: 40 },
      { field: 'remembered', iterations: 40 },
      { field: 'remembered', iterations: 40 },
      { field: 'remembered', iterations: 40 },
    ]);

    expect(loadStats(root).total_remembered).toBe(160);

    // loadStats coerces with Number(), so it would not notice the column
    // holding "160.0"; node:sqlite binds a JS number as REAL.
    const db = openHippoDb(root);
    try {
      expect(getMeta(db, 'total_remembered', '0')).toBe('160');
    } finally {
      closeHippoDb(db);
    }
  }, 60_000);

  it('a write to one counter does not roll back another', async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-stats-clobber-'));
    initStore(root);

    await runWorkers([
      { field: 'remembered', iterations: 60 },
      { field: 'forgotten', iterations: 60 },
    ]);

    const stats = loadStats(root);
    expect(stats.total_remembered).toBe(60);
    expect(stats.total_forgotten).toBe(60);
  }, 60_000);
});
