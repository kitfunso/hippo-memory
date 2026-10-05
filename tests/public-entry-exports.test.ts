import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as entry from '../src/index.js';
import { strengthBucket } from '../src/dedupe.js';
import { sleep } from '../src/api/sleep.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs `script` in a child and returns the JSON on its last stdout line. */
function importBuiltEntry<T>(script: string): T {
  // cwd is the checkout, not a temp dir, because self-reference resolves from the nearest package.json; the children only import and call pure functions.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (child.status !== 0) {
    throw new Error(
      `self-reference import failed (run \`npm run build\` first):\n${child.error?.message ?? ''}${child.stderr}`,
    );
  }
  const lines = child.stdout.trim().split('\n');
  // SAFETY: each caller's script is the only writer of the last stdout line and always emits the keys of T.
  return JSON.parse(lines[lines.length - 1]) as T;
}

// Announced public in CHANGELOG 1.26.3; guards the entry surface, which no other test imports through.
describe('package entry re-exports strengthBucket', () => {
  it('src/index.ts exposes the same function dedupe.ts defines', () => {
    expect(entry.strengthBucket).toBe(strengthBucket);
    expect(entry.strengthBucket(1)).toBe(100);
  });

  it('the built package resolves it by name from this checkout', () => {
    const script = [
      "const url = import.meta.resolve('hippo-memory');",
      "const m = await import('hippo-memory');",
      'console.log(JSON.stringify({ url, type: typeof m.strengthBucket, one: m.strengthBucket?.(1) }));',
    ].join('\n');
    const out = importBuiltEntry<{ url: string; type: string; one: number }>(script);
    expect(realpathSync(fileURLToPath(out.url))).toBe(realpathSync(resolve(REPO_ROOT, 'dist', 'index.js')));
    expect(out.type).toBe('function');
    expect(out.one).toBe(100);
    const dts = readFileSync(resolve(REPO_ROOT, 'dist', 'index.d.ts'), 'utf-8');
    expect(dts).toMatch(/^export \{ strengthBucket \} from '\.\/dedupe\.js';$/m);
  });
});

// An add-on runs consolidation in its own process; adminActor stays internal because sleep reads only actor.subject.
describe('package entry re-exports sleep', () => {
  it('src/index.ts exposes the same function api/sleep.ts defines, and not adminActor', () => {
    expect(entry.sleep).toBe(sleep);
    expect('adminActor' in entry).toBe(false);
  });

  it('the built package resolves sleep by name and ships its option and result types', () => {
    const script = [
      "const m = await import('hippo-memory');",
      "console.log(JSON.stringify({ type: typeof m.sleep, admin: 'adminActor' in m }));",
    ].join('\n');
    const out = importBuiltEntry<{ type: string; admin: boolean }>(script);
    expect(out.type).toBe('function');
    expect(out.admin).toBe(false);
    const dts = readFileSync(resolve(REPO_ROOT, 'dist', 'index.d.ts'), 'utf-8');
    expect(dts).toMatch(/^export \{ sleep, type SleepOpts, type SleepResult \} from '\.\/api\/sleep\.js';$/m);
    // The phase-override seam lives in sleep-run.ts, so the public declaration must not name it.
    expect(readFileSync(resolve(REPO_ROOT, 'dist', 'api', 'sleep.d.ts'), 'utf-8')).not.toMatch(/__phases|SleepPhases/);
  });
});
