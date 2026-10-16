import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliApiContext } from '../src/cli/api-context.js';
import { initStore } from '../src/store/open.js';
import { remember } from '../src/api/index.js';
import { getMemory } from '../src/api/memories/memories.js';

describe('cliApiContext', () => {
  it('carries a SQLite store built on its root, so the api layer never builds one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-cli-ctx-'));
    try {
      initStore(root);
      const ctx = cliApiContext(root, 'default');
      expect(ctx.store).toBeDefined();
      expect(ctx.store.kind).toBe('sqlite');
      const saved = await remember(ctx, { content: 'cli context store round trip' });
      expect((await getMemory(ctx, saved.id))?.content).toBe('cli context store round trip');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
