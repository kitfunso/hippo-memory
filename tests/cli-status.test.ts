import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');

describe('hippo status (v0.30.1)', () => {
  it('shows trace layer count after recording a trace', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-status-'));
    const env = { ...process.env, HIPPO_HOME: join(home, '.hippo') };
    execFileSync('node', [HIPPO_BIN, 'init'], { cwd: home, env, encoding: 'utf-8' });
    execFileSync('node', [HIPPO_BIN, 'trace', 'record',
      '--task', 't', '--steps', '[{"action":"a","observation":"o"}]',
      '--outcome', 'success'], { cwd: home, env, encoding: 'utf-8' });
    const out = execFileSync('node', [HIPPO_BIN, 'status'], { cwd: home, env, encoding: 'utf-8' });
    expect(out).toMatch(/Trace:\s+1/);
  });
});
