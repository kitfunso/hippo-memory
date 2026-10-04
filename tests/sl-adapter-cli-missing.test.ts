import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { storeDirOf } from './fixtures/sl-adapter/store-dir.js';

// HIPPO_BENCH_CLI is read at module load, so each case resets modules and re-imports the adapter.
async function loadAdapter(cli: string) {
  process.env.HIPPO_BENCH_CLI = cli;
  vi.resetModules();
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
    expect(storeDirOf(adapter)).toBeNull();
  });

  it('init() rejects when the CLI prints to stdout and then exits non-zero (codex round 4 P1)', async () => {
    const adapter = await loadAdapter(join(process.cwd(), 'tests', 'fixtures', 'sl-adapter', 'fake-cli-fails-late.mjs'));
    await expect(adapter.init()).rejects.toThrow(/failed to start/);
    expect(storeDirOf(adapter)).toBeNull();
  });

  it('a relative HIPPO_BENCH_CLI resolves against the startup cwd, not the temp store', async () => {
    const adapter = await loadAdapter('tests/fixtures/sl-adapter/fake-cli-ok.mjs');
    await adapter.init();
    const dir = storeDirOf(adapter);
    if (!dir) throw new Error('init() left no store dir');
    expect(existsSync(dir)).toBe(true);
    await adapter.cleanup();
    expect(existsSync(dir)).toBe(false);
  });
});
