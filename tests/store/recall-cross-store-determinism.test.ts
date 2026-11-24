import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { hybridSearch } from '../../src/entry/folder-search.js';
import { searchBothHybrid } from '../../src/domain/sharing/search-both.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry } = sessionPerTest();

const NOW = new Date('2026-01-15T00:00:00.000Z');

const CONTENTS = [
  'orbit nebula quasar pulsar filler content wholly unrelated to the probe',
  'zzyzx wombat jackal ocelot signalword',
  'wombat jackal zzyzx ocelot signalword',
  'jackal zzyzx wombat ocelot signalword',
  'ocelot jackal wombat zzyzx signalword',
  'signalword appears here too but this particular document is padded with a great many additional filler words so its length differs substantially from the short tie group above',
];

const TIE_GROUP_SORTED = [CONTENTS[3], CONTENTS[4], CONTENTS[2], CONTENTS[1]].sort();

const QUERY = 'signalword';

const TS_OFFSET_MS = [0, 1000, 1000, 1000, 1000, 2000];

function ingestFixture(root: string, pathTag: string): void {
  CONTENTS.forEach((content, i) => {
    const entry: MemoryEntry = createMemory(content, {
      layer: Layer.Episodic,
      tags: [pathTag],
    });
    const ts = new Date(NOW.getTime() + TS_OFFSET_MS[i]).toISOString();
    entry.created = ts;
    entry.lastRetrieved = ts;
    writeEntry(root, entry);
  });
}

describe('recall cross-store determinism', () => {
  let storeA: string;
  let storeB: string;

  beforeEach(() => {
    storeA = makeRoot('tiebreak-storeA');
    storeB = makeRoot('tiebreak-storeB-different-name');
    ingestFixture(storeA, 'path:store-a');
    ingestFixture(storeB, 'path:store-b');
  });

  it('hybridSearch returns identical top-K content sequences across differently-named fresh stores', async () => {
    const entriesA = loadAllEntries(storeA, 'default');
    const entriesB = loadAllEntries(storeB, 'default');
    expect(entriesA.length).toBe(CONTENTS.length);
    expect(entriesB.length).toBe(CONTENTS.length);

    const resultsA = await hybridSearch(QUERY, entriesA, {
      budget: 100_000,
      now: NOW,
      hippoRoot: storeA,
      minResults: 1,
    });
    const resultsB = await hybridSearch(QUERY, entriesB, {
      budget: 100_000,
      now: NOW,
      hippoRoot: storeB,
      minResults: 1,
    });

    const contentsA = resultsA.map((r) => r.entry.content);
    const contentsB = resultsB.map((r) => r.entry.content);

    expect(contentsA).toEqual(contentsB);

    expect(contentsA).not.toContain(CONTENTS[0]);

    const groupOrderA = contentsA.filter((c) => TIE_GROUP_SORTED.includes(c));
    const groupOrderB = contentsB.filter((c) => TIE_GROUP_SORTED.includes(c));
    expect(groupOrderA).toEqual(TIE_GROUP_SORTED);
    expect(groupOrderB).toEqual(TIE_GROUP_SORTED);
  });

  it('searchBothHybrid starts the global load while the local one is still out', async () => {
    const [local, global] = sharingStores(storeA, storeB);
    const events: string[] = [];
    const searchLocal = local.store.sharing.searchEntries.bind(local.store.sharing);
    const searchGlobal = global.store.sharing.searchEntries.bind(global.store.sharing);
    vi.spyOn(local.store.sharing, 'searchEntries').mockImplementation(async (...args) => {
      events.push('local:start');
      await new Promise((done) => setImmediate(done));
      const found = await searchLocal(...args);
      events.push('local:end');
      return found;
    });
    vi.spyOn(global.store.sharing, 'searchEntries').mockImplementation(async (...args) => {
      events.push('global:start');
      return searchGlobal(...args);
    });

    const results = await searchBothHybrid(QUERY, local, global, {
      tenantId: ALL_TENANTS,
      embedderFor: resolveEmbeddingProvider,
      budget: 100_000,
      now: NOW,
    });

    expect(events).toEqual(['local:start', 'global:start', 'local:end']);
    expect(results.length).toBeGreaterThan(0);
  });

  it('searchBothHybrid returns identical top-K content sequences across differently-named fresh stores', async () => {
    const emptyGlobalA = path.join(os.tmpdir(), 'hippo-tiebreak-no-such-global-a');
    const emptyGlobalB = path.join(os.tmpdir(), 'hippo-tiebreak-no-such-global-b-x');

    const resultsA = await searchBothHybrid(QUERY, ...sharingStores(storeA, emptyGlobalA), {
      tenantId: ALL_TENANTS,
      embedderFor: resolveEmbeddingProvider,
      budget: 100_000,
      now: NOW,
      localBump: 1.0, // remove the local-bias multiplier so this mirrors the plain hybridSearch case
    });
    const resultsB = await searchBothHybrid(QUERY, ...sharingStores(storeB, emptyGlobalB), {
      tenantId: ALL_TENANTS,
      embedderFor: resolveEmbeddingProvider,
      budget: 100_000,
      now: NOW,
      localBump: 1.0,
    });

    const contentsA = resultsA.map((r) => r.entry.content);
    const contentsB = resultsB.map((r) => r.entry.content);
    expect(contentsA).toEqual(contentsB);
    expect([...contentsA].sort()).toEqual(CONTENTS.slice(1).sort());
  });
});
