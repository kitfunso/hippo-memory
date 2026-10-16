import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { runInProcess } from './_helpers/run-in-process.js';

/** `hippo <args>` run in this process from `home` as tenant `tenant`, the call bin/hippo.js makes; a non-zero exit fails the test. */
async function hippo(home: string, tenant: string, ...args: string[]): Promise<string> {
  vi.stubEnv('HIPPO_TENANT', tenant);
  const saved = process.cwd();
  process.chdir(home);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

describe('cross-tenant recall isolation', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('tenant A recall does not return tenant B memories', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-iso-'));
    vi.stubEnv('HIPPO_HOME', home);
    try {
      await hippo(home, 'tenant_a', 'init');
      await hippo(home, 'tenant_a', 'init', '--global');
      await hippo(home, 'tenant_a', 'remember', 'alpha-secret-xyz unique-tenant-marker', '--global');
      await hippo(home, 'tenant_b', 'remember', 'beta-secret-xyz unique-tenant-marker', '--global');

      const aOut = await hippo(home, 'tenant_a', 'recall', 'secret-xyz');
      const bOut = await hippo(home, 'tenant_b', 'recall', 'secret-xyz');

      expect(aOut).toContain('alpha-secret-xyz');
      expect(aOut).not.toContain('beta-secret-xyz');
      expect(bOut).toContain('beta-secret-xyz');
      expect(bOut).not.toContain('alpha-secret-xyz');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
