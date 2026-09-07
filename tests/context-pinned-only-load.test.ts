// The pinned-only branch of getContext used to load every row of both stores to
// return about eleven. These pin what the narrower load must still return.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore, writeEntry, loadAmbientCandidates } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { isContentWorthStoring } from '../src/audit.js';
import { getContext, type Context } from '../src/api.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';

const PROJECT = 'proj-a';

let tmpRoot: string;
let local: string;
let globalRoot: string;
let ctx: Context;

function seed(root: string, content: string, extra: Record<string, unknown> = {}) {
  const entry = { ...createMemory(content), origin_project: PROJECT, ...extra };
  writeEntry(root, entry);
  return entry;
}

function ids(result: { entries: Array<{ entry: { id: string } }> }) {
  return result.entries.map((e) => e.entry.id);
}

beforeEach(() => {
  _resetAblationCacheForTests();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-pinned-load-'));
  local = path.join(tmpRoot, 'local', '.hippo');
  globalRoot = path.join(tmpRoot, 'global');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  initStore(local);
  initStore(globalRoot);
  process.env.HIPPO_HOME = globalRoot;
  ctx = { hippoRoot: local, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
});

afterEach(() => {
  delete process.env.HIPPO_HOME;
  _resetAblationCacheForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('pinned-only context loads a slice, not the corpus', () => {
  it('returns a pin that sits far outside the recent window', async () => {
    for (let i = 0; i < 60; i++) {
      seed(local, `filler row number ${i} with enough words to be worth storing`, {
        created: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
      });
    }
    const oldPin = seed(local, 'the pinned decision that predates every filler row', {
      pinned: true,
      created: '2020-01-01T00:00:00.000Z',
    });

    const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT });

    expect(ids(result)).toContain(oldPin.id);
  });

  it('returns the newest admissible rows for the recent-N backfill', async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      seed(local, `recent candidate row ${i} with enough words to be worth storing`, {
        created: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
      }),
    );

    const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 3, currentProject: PROJECT });

    const newest = rows.slice(-3).map((r) => r.id);
    for (const id of newest) expect(ids(result)).toContain(id);
  });

  it('falls back to the whole store when the window is all cross-project', async () => {
    for (let i = 0; i < 50; i++) {
      seed(local, `another project's newest row ${i} with enough words to be worth storing`, {
        origin_project: 'proj-b',
        created: new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString(),
      });
    }
    const buried = seed(local, 'the only row this project owns, far behind the window', {
      created: '2026-01-01T00:00:00.000Z',
    });

    const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT });

    expect(ids(result)).toContain(buried.id);
  });

  it('never returns a superseded row, however new it is', async () => {
    const superseded = seed(local, 'the superseded row is the newest thing in the store', {
      created: '2026-08-01T00:00:00.000Z',
      superseded_by: 'some-newer-id',
      pinned: true,
    });
    seed(local, 'an ordinary current row that keeps the store non-empty', {
      created: '2026-07-01T00:00:00.000Z',
    });

    const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT });

    expect(ids(result)).not.toContain(superseded.id);
  });

  it('pulls pins from the global store as well as the local one', async () => {
    const globalPin = seed(globalRoot, 'a global pin that must still reach the prompt', { pinned: true });
    seed(local, 'a local row so both stores have something in them');

    const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT });

    expect(ids(result)).toContain(globalPin.id);
  });

  it('keeps the pinned budget reserve, so a pin is not displaced by recents', async () => {
    for (let i = 0; i < 20; i++) {
      seed(local, `a long recent row ${i} ${'padding words '.repeat(30)}`, {
        created: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
      });
    }
    const pin = seed(local, 'the pin that a greedy recent loop would starve', {
      pinned: true,
      created: '2020-01-01T00:00:00.000Z',
    });

    const result = await getContext(ctx, {
      pinnedOnly: true,
      includeRecent: 5,
      budget: 400,
      currentProject: PROJECT,
    });

    expect(ids(result)).toContain(pin.id);
  });

  // The load's "found enough?" test has to use the caller's whole admission
  // rule, quality floor included, or it stops at a window of junk.
  it('reaches past newest rows that pass admission but fail the quality floor', async () => {
    const JUNK = 'need to check the cache thing';
    expect(isContentWorthStoring(JUNK)).toBe(false);

    const older = Array.from({ length: 10 }, (_, i) =>
      seed(local, `an older row ${i} that carries enough words to clear the quality floor`, {
        created: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      }),
    );
    for (let i = 0; i < 32; i++) {
      seed(local, JUNK, { created: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString() });
    }

    const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT });

    const returned = ids(result);
    expect(returned.length).toBe(5);
    for (const id of returned) expect(older.map((o) => o.id)).toContain(id);
  });

  it('returns a pin whose own content fails the quality floor', async () => {
    const JUNK = 'need to check the cache thing';
    expect(isContentWorthStoring(JUNK)).toBe(false);

    const junkPin = seed(local, JUNK, { pinned: true, created: '2020-01-01T00:00:00.000Z' });
    seed(local, 'an ordinary recent row with enough words to clear the floor', {
      created: '2026-06-01T00:00:00.000Z',
    });

    const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT });

    expect(ids(result)).toContain(junkPin.id);
  });

  it('widens the search when the window yields some rows but fewer than N', async () => {
    const JUNK = 'need to check the cache thing';
    const older = Array.from({ length: 5 }, (_, i) =>
      seed(local, `an older row ${i} that carries enough words to clear the quality floor`, {
        created: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      }),
    );
    const partial = Array.from({ length: 2 }, (_, i) =>
      seed(local, `a mid row ${i} that carries enough words to clear the quality floor`, {
        created: new Date(Date.UTC(2026, 4, 1, 0, i)).toISOString(),
      }),
    );
    for (let i = 0; i < 30; i++) {
      seed(local, JUNK, { created: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString() });
    }

    const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT });

    const returned = ids(result);
    expect(returned).toContain(partial[1].id);
    expect(returned).toContain(older[4].id);
    expect(returned.length).toBe(5);
  });

  it('returns exactly the pins plus the newest N, nothing else', async () => {
    const pinA = seed(local, 'the first pinned decision, old but always injected', {
      pinned: true,
      created: '2020-01-01T00:00:00.000Z',
    });
    const pinB = seed(local, 'the second pinned decision, also old and also injected', {
      pinned: true,
      created: '2020-01-02T00:00:00.000Z',
    });
    const recents = Array.from({ length: 4 }, (_, i) =>
      seed(local, `an ordinary recent row ${i} with enough words to clear the floor`, {
        created: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
      }),
    );

    const result = await getContext(ctx, {
      pinnedOnly: true,
      includeRecent: 2,
      budget: 5000,
      currentProject: PROJECT,
    });

    expect(new Set(ids(result))).toEqual(
      new Set([pinA.id, pinB.id, recents[3].id, recents[2].id]),
    );
  });

  it('sources recent-N candidates from the global store too', async () => {
    seed(local, 'one old local row so the local store is not empty', {
      created: '2020-01-01T00:00:00.000Z',
    });
    const globals = Array.from({ length: 3 }, (_, i) =>
      seed(globalRoot, `a recent global row ${i} with enough words to clear the floor`, {
        created: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
      }),
    );

    const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 2, currentProject: PROJECT });

    expect(ids(result)).toContain(globals[2].id);
    expect(ids(result)).toContain(globals[1].id);
  });

  it('returns nothing for two empty stores', async () => {
    const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT });

    expect(result.entries).toEqual([]);
    expect(result.tokens).toBe(0);
  });
});

describe('loadAmbientCandidates', () => {
  it('scopes to the caller tenant', () => {
    const mine = { ...createMemory('a row belonging to tenant a', { tenantId: 'tenant-a' }), pinned: true };
    const theirs = { ...createMemory('a row belonging to tenant b', { tenantId: 'tenant-b' }), pinned: true };
    writeEntry(local, mine);
    writeEntry(local, theirs);

    const got = loadAmbientCandidates(local, 'tenant-a', 5, () => true);

    expect(got.map((e) => e.id)).toContain(mine.id);
    expect(got.map((e) => e.id)).not.toContain(theirs.id);
  });

  it('breaks a same-created tie on id descending, matching the caller comparator', () => {
    const created = '2026-05-05T05:05:05.000Z';
    for (let i = 0; i < 40; i++) {
      writeEntry(local, { ...createMemory(`tied row ${i}`), created, id: `id-${String(i).padStart(3, '0')}` });
    }

    const got = loadAmbientCandidates(local, 'default', 3, () => true);
    const newestThree = got.map((e) => e.id).sort().slice(-3);

    expect(newestThree).toEqual(['id-037', 'id-038', 'id-039']);
  });

  it('returns rows in loadAllEntries order so a stable sort downstream sees the same input', () => {
    for (let i = 0; i < 10; i++) {
      writeEntry(local, {
        ...createMemory(`ordered row ${i}`),
        pinned: true,
        created: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
      });
    }

    const got = loadAmbientCandidates(local, 'default', 5, () => true);
    const sorted = [...got].sort((a, b) =>
      a.created.localeCompare(b.created) || a.id.localeCompare(b.id),
    );

    expect(got.map((e) => e.id)).toEqual(sorted.map((e) => e.id));
  });

  it('asks for nothing recent when the caller wants no backfill', () => {
    writeEntry(local, { ...createMemory('an unpinned row nobody asked for'), created: '2026-08-08T00:00:00.000Z' });
    const pin = { ...createMemory('the only pin in the store'), pinned: true };
    writeEntry(local, pin);

    const got = loadAmbientCandidates(local, 'default', 0, () => true);

    expect(got.map((e) => e.id)).toEqual([pin.id]);
  });
});
