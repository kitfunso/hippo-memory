import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const cli = resolve(__dirname, '..', 'dist', 'cli.js');

describe('hippo audit list', () => {
  it('lists events after remember + recall', () => {
    if (!existsSync(cli)) throw new Error('build first');
    const home = mkdtempSync(join(tmpdir(), 'hippo-audit-cli-'));
    const env = { ...process.env, HIPPO_HOME: home };
    try {
      execSync(`node "${cli}" init`, { env, cwd: home });
      execSync(`node "${cli}" init --global`, { env, cwd: home });
      execSync(`node "${cli}" remember "audit-list-canary distinguishing token" --global`, { env, cwd: home });
      execSync(`node "${cli}" recall "audit-list-canary" --global`, { env, cwd: home });

      const out = execSync(`node "${cli}" audit list --json --global`, { env, cwd: home }).toString();
      const events = JSON.parse(out);
      const ops = events.map((e: { op: string }) => e.op);
      expect(ops).toContain('remember');
      expect(ops).toContain('recall');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
