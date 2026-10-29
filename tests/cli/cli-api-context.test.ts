import { describe, it, expect } from 'vitest';
import { cliCommand } from '../../src/surface/cli/api-context.js';
import { remember } from '../../src/api/index.js';
import { memoryGet } from '../../src/api/memories/memories.js';
import { makeRoot } from '../_helpers/make-root.js';

describe('cliCommand apiContext', () => {
  it('carries a SQLite store built on its root, so the api layer never builds one', async () => {
    const root = makeRoot('cli-ctx');
    const ctx = cliCommand().apiContext(root, 'default');
    expect(ctx.store.kind).toBe('sqlite');
    const saved = await remember(ctx, { content: 'cli context store round trip' });
    expect((await memoryGet(ctx, saved.id))?.content).toBe('cli context store round trip');
  });
});
