// updateStats read-modify-wrote all three meta counters with no transaction and
// wrote all three back, so concurrent writers lost increments and clobbered
// counters they had not touched (store/sqlite/index-and-stats.ts atomic-increment fix).
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { openHippoDb, closeHippoDb, getMeta } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';

let root: string;

// The workers must exercise the shipped updateStatsAt on the shipped opener, not a copy of them, so they
// import the build output.
const DIST_STORE = join(import.meta.dirname, '..', '..', 'dist', 'store');
const STORE_URL = pathToFileURL(join(DIST_STORE, 'sqlite', 'index-and-stats.js')).href;
const HANDLES_URL = pathToFileURL(join(DIST_STORE, 'sqlite', 'handles.js')).href;

function workerScript(hippoRoot: string, field: string, iterations: number): string {
  return `
    import { updateStatsAt } from ${JSON.stringify(STORE_URL)};
    import { onHandle, openStore } from ${JSON.stringify(HANDLES_URL)};
    const hippoRoot = ${JSON.stringify(hippoRoot)};
    for (let i = 0; i < ${iterations}; i++) {
      onHandle(hippoRoot, (db) => updateStatsAt(db, { hippoRoot }, { ${field}: 1 }), openStore);
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
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`worker ${i} exited ${code}: ${stderr}`)),
        );
      });
    }),
  );
}

describe('updateStats under concurrent writers', () => {
  it('every increment to one counter lands', async () => {
    root = makeRoot('stats-race');

    await runWorkers([
      { field: 'remembered', iterations: 40 },
      { field: 'remembered', iterations: 40 },
      { field: 'remembered', iterations: 40 },
      { field: 'remembered', iterations: 40 },
    ]);

    expect(sqliteSyncStore(root).reports.stats().total_remembered).toBe(160);

    // reports.stats() coerces with Number(), so it would not notice the column
    // holding "160.0"; node:sqlite binds a JS number as REAL.
    const db = openHippoDb(root);
    try {
      expect(getMeta(db, 'total_remembered', '0')).toBe('160');
    } finally {
      closeHippoDb(db);
    }
  });

  it('a write to one counter does not roll back another', async () => {
    root = makeRoot('stats-clobber');

    await runWorkers([
      { field: 'remembered', iterations: 60 },
      { field: 'forgotten', iterations: 60 },
    ]);

    const stats = sqliteSyncStore(root).reports.stats();
    expect(stats.total_remembered).toBe(60);
    expect(stats.total_forgotten).toBe(60);
  });
});
