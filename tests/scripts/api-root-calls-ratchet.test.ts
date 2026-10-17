import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-api-root-calls.mjs');
const STORE = 'export function readThing(hippoRoot: string) { return hippoRoot; }\nexport function other(db: string) { return db; }\n';

function withFixture(apiSource: string, baseline: Record<string, number>, body: (run: () => { status: number | null; stderr: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'hippo-api-root-calls-'));
  const write = (p: string, text: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  try {
    write('src/store/thing.ts', STORE);
    write('src/api/a.ts', apiSource);
    write('.api-root-calls-baseline.json', JSON.stringify(baseline));
    body(() => {
      const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf-8' });
      return { status: r.status, stderr: r.stderr };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('check-api-root-calls.mjs', () => {
  it('fails on a runtime import of a root-keyed store function above the baseline', () => {
    withFixture("import { readThing } from '../store/thing.js';\n", {}, (run) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/api/a.ts: new -> 1');
    });
  });

  it('passes at the baseline and ignores type imports and other functions', () => {
    const src = "import { readThing, type readThing as T } from '../store/thing.js';\nimport { other } from '../store/thing.js';\nimport type { readThing as R } from '../store/thing.js';\n";
    withFixture(src, { 'src/api/a.ts': 1 }, (run) => {
      expect(run().status).toBe(0);
    });
  });
});
