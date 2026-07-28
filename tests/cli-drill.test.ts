import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initStore } from '../src/store.js';

const CLI = resolve(__dirname, '..', 'bin', 'hippo.js');

describe('hippo drill CLI', () => {
  it('rejects fractional depth', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-cli-drill-'));
    initStore(join(home, '.hippo'));

    try {
      execFileSync('node', [CLI, 'drill', 'missing', '--depth', '1.5'], {
        cwd: home,
        encoding: 'utf8',
        env: { ...process.env, HIPPO_HOME: join(home, '.hippo-global') },
      });
      throw new Error('expected hippo drill to reject fractional depth');
    } catch (error) {
      const failure = error as { status?: number; stderr?: string | Buffer };
      expect(failure.status).toBe(2);
      expect(String(failure.stderr)).toContain('--depth must be an integer between 1 and 10');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
