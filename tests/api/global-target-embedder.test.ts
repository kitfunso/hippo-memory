// A host-built reach.globalTarget of { store, config } embeds the global copy through the context's embedder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import { promote } from '../../src/api/memories/promote.js';
import { shareToGlobal } from '../../src/api/sharing.js';
import type { ContextReach } from '../../src/api/types.js';
import { testInfra } from '../_helpers/infra.js';
import { apiCtx, type FullContext } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

// Type-level: this host-built reach fails to compile when `embedderFor` is required on globalTarget.
export const hostReach = (reach: ContextReach): ContextReach => ({
  ...reach,
  globalTarget: reach.globalTarget && {
    store: reach.globalTarget.store,
    config: reach.globalTarget.config,
  },
});

describe('a host-built global target without embedderFor', () => {
  const embedded: string[] = [];
  let hippoRoot: string;
  let ctx: FullContext;

  beforeEach(() => {
    embedded.length = 0;
    const tmp = makeRoot('global-target-embedder', { init: false });
    hippoRoot = join(tmp, 'proj', '.hippo');
    initTestStore(hippoRoot);
    vi.stubEnv('HIPPO_HOME', join(tmp, 'global'));
    const provider: EmbeddingProvider = {
      kind: 'local',
      model: 'fake',
      id: 'fake',
      isAvailable: () => true,
      embed: async (texts) => {
        embedded.push(...texts);
        return texts.map(() => [1, 0, 0]);
      },
    };
    const base = apiCtx(hippoRoot);
    if (base.reach === undefined) throw new Error('apiCtx sets a reach');
    ctx = {
      ...base,
      reach: hostReach(base.reach),
      infra: { ...testInfra(), embedderFor: () => provider },
    };
  });

  it('promote embeds the global copy through the context embedder', async () => {
    const entry = createMemory('gotcha: promote embeds through the context', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeEntry(hippoRoot, entry);
    expect(ctx.reach?.globalTarget?.embedderFor).toBeUndefined();
    await promote(ctx, entry.id);
    await vi.waitFor(() => expect(embedded.some((t) => t.includes(entry.content))).toBe(true));
  });

  it('shareToGlobal embeds the global copy through the context embedder', async () => {
    const entry = createMemory('gotcha: share embeds through the context', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['error'],
    });
    writeEntry(hippoRoot, entry);
    const copy = await shareToGlobal(ctx, entry.id, { force: true });
    expect(copy).not.toBeNull();
    await vi.waitFor(() => expect(embedded.some((t) => t.includes(entry.content))).toBe(true));
  });
});
