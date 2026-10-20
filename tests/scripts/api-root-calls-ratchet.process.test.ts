import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-api-root-calls.mjs');
const STORE =
  'export function readThing(hippoRoot: string) { return hippoRoot; }\nexport function other(db: string) { return db; }\n';

function withFixture(apiSource: string, body: (run: () => { status: number | null; stderr: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'hippo-api-root-calls-'));
  const write = (p: string, text: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  try {
    write('src/store/thing.ts', STORE);
    write('src/api/a.ts', apiSource);
    body(() => {
      const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf-8' });
      return { status: r.status, stderr: r.stderr };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('check-api-root-calls.mjs', () => {
  it('fails on any runtime import of a root-keyed store function', () => {
    withFixture("import { readThing } from '../store/thing.js';\n", (run) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/api/a.ts: 1');
    });
  });

  it('passes on type imports and functions not keyed by a root', () => {
    const src =
      "import { type readThing as T } from '../store/thing.js';\nimport { other } from '../store/thing.js';\nimport type { readThing as R } from '../store/thing.js';\n";
    withFixture(src, (run) => {
      expect(run().status).toBe(0);
    });
  });
});
