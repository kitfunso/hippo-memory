import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const cli = resolve(__dirname, '..', 'dist', 'cli.js');

describe('hippo auth CLI', () => {
  it('create -> list -> revoke flow', () => {
    if (!existsSync(cli)) throw new Error('build first');
    const home = mkdtempSync(join(tmpdir(), 'hippo-auth-cli-'));
    const env = { ...process.env, HIPPO_HOME: home };
    try {
      execSync(`node "${cli}" init --global`, { env, cwd: home });

      const createOut = execSync(`node "${cli}" auth create --label test --global`, { env, cwd: home }).toString();
      const keyMatch = createOut.match(/(hk_[a-z2-7]{24})/);
      const plainMatch = createOut.match(/(hk_[a-z2-7]{24}\.[a-z2-7]+)/);
      expect(keyMatch, 'key_id missing in output').toBeTruthy();
      expect(plainMatch, 'plaintext missing in output').toBeTruthy();
      const keyId = keyMatch![1]!;

      const listOut = execSync(`node "${cli}" auth list --global`, { env, cwd: home }).toString();
      expect(listOut).toContain(keyId);
      expect(listOut).toContain('test');

      execSync(`node "${cli}" auth revoke ${keyId} --global`, { env, cwd: home });
      const listAfter = execSync(`node "${cli}" auth list --global`, { env, cwd: home }).toString();
      expect(listAfter).not.toContain(keyId);

      const listAll = execSync(`node "${cli}" auth list --all --global`, { env, cwd: home }).toString();
      expect(listAll).toContain(keyId);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
