import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = resolve(__dirname, '..');
const cli = resolve(repoRoot, 'dist', 'cli.js');

describe('cross-tenant recall isolation (A5 ROADMAP commitment)', () => {
  it('tenant A recall does not return tenant B memories', () => {
    if (!existsSync(cli)) {
      throw new Error(`dist/cli.js not found at ${cli} — run \`npm run build\` first`);
    }
    const home = mkdtempSync(join(tmpdir(), 'hippo-iso-'));
    const envA = { ...process.env, HIPPO_HOME: home, HIPPO_TENANT: 'tenant_a' };
    const envB = { ...process.env, HIPPO_HOME: home, HIPPO_TENANT: 'tenant_b' };
    try {
      execSync(`node "${cli}" init`, { env: envA, cwd: home });
      execSync(`node "${cli}" init --global`, { env: envA, cwd: home });
      execSync(`node "${cli}" remember "alpha-secret-xyz unique-tenant-marker" --global`, { env: envA, cwd: home });
      execSync(`node "${cli}" remember "beta-secret-xyz unique-tenant-marker" --global`, { env: envB, cwd: home });

      const aOut = execSync(`node "${cli}" recall "secret-xyz" --global`, { env: envA, cwd: home }).toString();
      const bOut = execSync(`node "${cli}" recall "secret-xyz" --global`, { env: envB, cwd: home }).toString();

      expect(aOut).toContain('alpha-secret-xyz');
      expect(aOut).not.toContain('beta-secret-xyz');
      expect(bOut).toContain('beta-secret-xyz');
      expect(bOut).not.toContain('alpha-secret-xyz');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
