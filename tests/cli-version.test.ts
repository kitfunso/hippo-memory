import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };

describe('hippo --version (v0.30.1)', () => {
  it('--version prints the package version', () => {
    const out = execFileSync('node', [HIPPO_BIN, '--version'], { encoding: 'utf-8' });
    expect(out.trim()).toBe(pkg.version);
  });

  it('-v prints the package version', () => {
    const out = execFileSync('node', [HIPPO_BIN, '-v'], { encoding: 'utf-8' });
    expect(out.trim()).toBe(pkg.version);
  });
});
