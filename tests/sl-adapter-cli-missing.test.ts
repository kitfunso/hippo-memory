import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

// Own file: HIPPO_BENCH_CLI is read at module load, so the override must be set before the import.
describe('sequential-learning hippo adapter refuses to run without a working CLI', () => {
  it('init() throws and names the build step when the CLI file cannot start', async () => {
    process.env.HIPPO_BENCH_CLI = join(process.cwd(), 'does-not-exist', 'hippo.js');
    // @ts-expect-error - .mjs adapter module without .d.ts
    const { default: adapter } = await import('../benchmarks/sequential-learning/adapters/hippo.mjs');
    await expect(adapter.init()).rejects.toThrow(/npm run build/);
    await adapter.cleanup();
  });
});
