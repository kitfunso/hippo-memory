import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as entry from '../src/index.js';
import { strengthBucket } from '../src/dedupe.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    if (child.status !== 0) {
      throw new Error(`self-reference import failed (run \`npm run build\` first):\n${child.stderr}`);
    }
    const lines = child.stdout.trim().split('\n');
    // SAFETY: the child script above is the only writer of the last stdout line and always emits these three keys.
    const out = JSON.parse(lines[lines.length - 1]) as { url: string; type: string; one: number };
    expect(realpathSync(fileURLToPath(out.url))).toBe(realpathSync(resolve(REPO_ROOT, 'dist', 'index.js')));
    expect(out.type).toBe('function');
    expect(out.one).toBe(100);
    const dts = readFileSync(resolve(REPO_ROOT, 'dist', 'index.d.ts'), 'utf-8');
    expect(dts).toMatch(/^export \{ strengthBucket \} from '\.\/dedupe\.js';$/m);
  });
});
