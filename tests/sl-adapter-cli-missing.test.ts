import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// HIPPO_BENCH_CLI is read at module load, so each case resets modules and re-imports the adapter.
async function loadAdapter(cli: string) {
  process.env.HIPPO_BENCH_CLI = cli;
  vi.resetModules();
  // @ts-expect-error - .mjs adapter module without .d.ts
  const { default: adapter } = await import('../benchmarks/sequential-learning/adapters/hippo.mjs');
  return adapter;
}

describe('sequential-learning hippo adapter refuses to run without a working CLI', () => {
  afterEach(() => {
    delete process.env.HIPPO_BENCH_CLI;
  });

  it('init() rejects, names the build step and leaves no temp store when the CLI file is missing', async () => {
    const adapter = await loadAdapter(join(process.cwd(), 'does-not-exist', 'hippo.js'));
    await expect(adapter.init()).rejects.toThrow(/npm run build/);
    expect(adapter._storeDir).toBeNull();
  });

  it('init() rejects when the CLI prints to stdout and then exits non-zero (codex round 4 P1)', async () => {
    const adapter = await loadAdapter(join(process.cwd(), 'tests', 'fixtures', 'sl-adapter', 'fake-cli-fails-late.mjs'));
    await expect(adapter.init()).rejects.toThrow(/failed to start/);
    expect(adapter._storeDir).toBeNull();
  });

  it('a relative HIPPO_BENCH_CLI resolves against the startup cwd, not the temp store', async () => {
    const adapter = await loadAdapter('tests/fixtures/sl-adapter/fake-cli-ok.mjs');
    await adapter.init();
    const dir = adapter._storeDir;
    expect(dir && existsSync(dir)).toBe(true);
    await adapter.cleanup();
    expect(existsSync(dir)).toBe(false);
  });
});
