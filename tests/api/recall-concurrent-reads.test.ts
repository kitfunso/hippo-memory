// The local and global recall reads overlap, and the merged ranking does not depend on which finishes first.
import { describe, it, expect } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { loadConfig } from '../../src/base/config/config.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { rankRecall, type RankRecallCtx, type RankRecallOptions } from '../../src/api/recall/pipeline.js';
import type { HippoStore } from '../../src/store/port.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { waitFor } from '../_helpers/wait-for.js';

type StoreName = 'local' | 'global';

interface Gate {
  readonly opened: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** The store with its recall read held at the start until `released`, so the test, not a timer, orders the reads. */
function held(store: HippoStore, name: StoreName, released: Promise<void>, events: string[]): HippoStore {
  const search = store.searchRecallEntries.bind(store);
  // SAFETY: Object.create keeps every other store method; only the read under test is replaced.
  const wrapped = Object.create(store) as HippoStore;
  wrapped.searchRecallEntries = async (...args: Parameters<HippoStore['searchRecallEntries']>) => {
    events.push(`${name}:start`);
    await released;
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

/** One recall with both reads held until both have started, then let go one at a time in `order`. */
async function run(order: readonly [StoreName, StoreName]): Promise<{ ids: string[]; events: string[] }> {
  const { root: local } = makeStore('recall-concurrent-local');
  const { root: global } = makeStore('recall-concurrent-global');
  writeEntry(local, { ...createMemory('deploy pipeline uses blue green rollout'), id: 'mem_local_a', strength: 1 });
  writeEntry(local, { ...createMemory('deploy gate waits for the smoke run'), id: 'mem_local_b', strength: 1 });
  writeEntry(global, { ...createMemory('deploy tokens rotate every quarter'), id: 'mem_global_a', strength: 1 });
  const events: string[] = [];
  const gates = { local: gate(), global: gate() };
  const ctx: RankRecallCtx = {
    store: held(sqliteStore(local), 'local', gates.local.opened, events),
    config: loadConfig(local),
    global: { store: held(sqliteStore(global), 'global', gates.global.opened, events), config: loadConfig(global) },
    tenantId: 'default',
  };
  const ranked = rankRecall(ctx, options(local));
  // Neither read may end yet, so a recall that ran them one after the other never starts the second.
  await waitFor(() => events.length === 2, { what: 'both store reads to start before either ends', timeoutMs: 4_000 });
  for (const name of order) {
    gates[name].open();
    await waitFor(() => events.includes(`${name}:end`), { what: `the ${name} read to end`, timeoutMs: 4_000 });
  }
  const result = await ranked;
  return { ids: result.results.map((r) => r.entry.id), events };
}

describe('rankRecall reads both stores at once', () => {
  it('starts the global read before the local read ends', async () => {
    const { events } = await run(['local', 'global']);
    expect(events).toEqual(['local:start', 'global:start', 'local:end', 'global:end']);
  });

  it('returns the same merged ranking whichever store answers first', async () => {
    const localFirst = await run(['local', 'global']);
    const globalFirst = await run(['global', 'local']);
    expect(globalFirst.events.slice(2)).toEqual(['global:end', 'local:end']);
    expect([...localFirst.ids].sort()).toEqual(['mem_global_a', 'mem_local_a', 'mem_local_b']);
    expect(globalFirst.ids).toEqual(localFirst.ids);
  });
});
