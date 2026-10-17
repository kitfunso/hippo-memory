import { describe, it, expect } from 'vitest';
import { cliApiContext } from '../src/cli/api-context.js';
import { remember } from '../src/api/index.js';
import { getMemory } from '../src/api/memories/memories.js';
import { makeRoot } from './_helpers/make-root.js';

describe('cliApiContext', () => {
  it('carries a SQLite store built on its root, so the api layer never builds one', async () => {
    const root = makeRoot('cli-ctx');
    const ctx = cliApiContext(root, 'default');
    expect(ctx.store).toBeDefined();
    expect(ctx.store.kind).toBe('sqlite');
    const saved = await remember(ctx, { content: 'cli context store round trip' });
    expect((await getMemory(ctx, saved.id))?.content).toBe('cli context store round trip');
  });
});
