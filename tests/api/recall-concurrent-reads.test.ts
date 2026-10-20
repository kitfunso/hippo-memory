// The local and global recall reads overlap, and the merged ranking does not depend on which finishes first.
import { describe, it, expect } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { loadConfig } from '../../src/base/config/config.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { rankRecall, type RankRecallCtx, type RankRecallOptions } from '../../src/api/recall/pipeline.js';
import type { HippoStore } from '../../src/store/port.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function slowed(store: HippoStore, name: string, delayMs: number, events: string[]): HippoStore {
  const search = store.searchRecallEntries.bind(store);
  // SAFETY: Object.create keeps every other store method; only the read under test is replaced.
  const wrapped = Object.create(store) as HippoStore;
  wrapped.searchRecallEntries = async (...args: Parameters<HippoStore['searchRecallEntries']>) => {
    events.push(`${name}:start`);
    await wait(delayMs);
    const out = await search(...args);
    events.push(`${name}:end`);
    return out;
  };
  return wrapped;
}

function options(root: string): RankRecallOptions {
  return {
    query: 'deploy',
    budget: 4000,
    cost: (r) => r.tokens,
    window: { limit: 10 },
    includeSuperseded: false,
    explicitScope: null,
    activeScope: null,
    search: {
      usePhysics: false,
      physicsConfig: loadConfig(root).physics,
      multihop: false,
      mmr: false,
      mmrLambda: 0.7,
      localBump: 1.2,
      explain: false,
    },
  };
}

async function run(localMs: number, globalMs: number): Promise<{ ids: string[]; events: string[] }> {
  const { root: local } = makeStore('recall-concurrent-local');
  const { root: global } = makeStore('recall-concurrent-global');
  writeEntry(local, { ...createMemory('deploy pipeline uses blue green rollout'), id: 'mem_local_a', strength: 1 });
  writeEntry(local, { ...createMemory('deploy gate waits for the smoke run'), id: 'mem_local_b', strength: 1 });
  writeEntry(global, { ...createMemory('deploy tokens rotate every quarter'), id: 'mem_global_a', strength: 1 });
  const events: string[] = [];
  const ctx: RankRecallCtx = {
    store: slowed(sqliteStore(local), 'local', localMs, events),
    config: loadConfig(local),
    global: { store: slowed(sqliteStore(global), 'global', globalMs, events), config: loadConfig(global) },
    tenantId: 'default',
  };
  const result = await rankRecall(ctx, options(local));
  return { ids: result.results.map((r) => r.entry.id), events };
}

describe('rankRecall reads both stores at once', () => {
  it('starts the global read before the local read ends', async () => {
    const { events } = await run(30, 5);
    expect(events.indexOf('global:start')).toBeLessThan(events.indexOf('local:end'));
  });

  it('returns the same merged ranking whichever store answers first', async () => {
    const localFirst = await run(1, 40);
    const globalFirst = await run(40, 1);
    expect(localFirst.ids.length).toBeGreaterThanOrEqual(3);
    expect(globalFirst.ids).toEqual(localFirst.ids);
  });
});
