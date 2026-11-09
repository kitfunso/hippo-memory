// The row writer stores no link for a blank one, so a memory a writer touches is live; raw SQL can still store a
// blank, and the writers that rewrite such a row (an outcome, a sleep strength refresh) are where it turns live.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as api from '../../src/api/index.js';
import { strengthOf } from '../../src/api/types.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { serializeEntry } from '../../src/base/memory/markdown.js';
import { calculateStrength } from '../../src/base/memory/strength.js';
import { DAY_MS } from '../../src/base/util/time.js';
import { sessionDecayContext } from '../../src/domain/consolidate/decay.js';
import { sqliteStore as kitStore } from '../../src/entry/store-kit.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { FIXED_NOW } from '../_helpers/fixed-clock.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { initTestStore } from '../_helpers/store-template.js';

const { writeEntry, sessionDb, sqliteStore, apiCtx } = sessionPerTest();

const NO_LINK = { superseded_by: null };
const BLANK_LINK = { superseded_by: '' };
const ADMIN = { subject: 'test', role: 'admin' } as const;

interface LinkRow {
  readonly superseded_by: string | null;
}

function storedLink(home: string, id: string): LinkRow | undefined {
  // SAFETY: the SELECT names the one column read.
  return sessionDb(home).prepare('SELECT superseded_by FROM memories WHERE id = ?').get(id) as LinkRow | undefined;
}

const blankBySql = (home: string, id: string): void => {
  sessionDb(home).prepare(`UPDATE memories SET superseded_by = '' WHERE id = ?`).run(id);
};

const liveIds = async (home: string): Promise<string[]> => {
  const live = await sqliteStore(home).entriesWhere({ tenantId: 'default', live: true }, { limit: 10 });
  return live.entries.map((e) => e.id);
};

describe('a blank superseded link is stored as no link', () => {
  it('when a markdown mirror holding an empty link is imported on the first open, and the memory is live', async () => {
    const home = path.join(makeRoot('blank-link-mirror', { init: false }), '.hippo');
    fs.mkdirSync(path.join(home, 'episodic'), { recursive: true });
    const entry = { ...createMemory('the release train leaves on thursdays'), supersededBy: '' };
    const mirror = serializeEntry(entry);
    expect(mirror).toMatch(/^superseded_by: ""$/m);
    fs.writeFileSync(path.join(home, 'episodic', `${entry.id}.md`), mirror);

    initTestStore(home);

    expect(storedLink(home, entry.id)).toEqual(NO_LINK);
    expect(await liveIds(home)).toEqual([entry.id]);
  });

  it('when a store-kit store writes the entry', async () => {
    const home = makeRoot('blank-link-store-kit');
    const entry = { ...createMemory('the staging cluster runs three spot nodes'), supersededBy: '' };
    const store = kitStore(home);
    try {
      await store.entryWrites.writeEntry({ entry, actor: 'cli' });
    } finally {
      await store.close();
    }

    expect(storedLink(home, entry.id)).toEqual(NO_LINK);
    expect(await liveIds(home)).toEqual([entry.id]);
  });

  it('when an outcome rewrites a row that raw SQL blanked, which turns the memory live', async () => {
    const home = makeRoot('blank-link-outcome');
    const entry = createMemory('the canary host was canary-3');
    writeEntry(home, entry);
    blankBySql(home, entry.id);
    expect(storedLink(home, entry.id)).toEqual(BLANK_LINK);

    const result = await api.outcome(apiCtx(home, 'default', ADMIN), [entry.id], true);

    expect(result.appliedIds).toEqual([entry.id]);
    expect(storedLink(home, entry.id)).toEqual(NO_LINK);
    expect(await liveIds(home)).toEqual([entry.id]);
  });
});

describe('a sleep over rows that raw SQL blanked', () => {
  // A sleep rewrites a row in its replay pass and in a strength refresh; a replay count of 0 isolates the refresh.
  const sleepCtx = (home: string, replayCount: number) => {
    const ctx = apiCtx(home, 'default', ADMIN);
    const replay = { ...ctx.config.replay, count: replayCount };
    return { ...ctx, config: { ...ctx.config, replay }, infra: { ...ctx.infra, clock: () => FIXED_NOW } };
  };
  // The score and options the sleep's decay pass uses, so a row stored at this strength gets no refresh.
  const decayedStrength = (ctx: ReturnType<typeof sleepCtx>, entry: MemoryEntry): number =>
    calculateStrength(entry, FIXED_NOW, strengthOf(ctx), {
      decayBasis: ctx.config.decayBasis,
      ...sessionDecayContext({ sleepCount: 0, recentRuns: [] }),
    });
  const aged = (content: string) => {
    const created = new Date(FIXED_NOW.getTime() - 20 * DAY_MS).toISOString();
    return { ...createMemory(content), created, lastRetrieved: created };
  };

  it('rewrites only the row whose strength moved, so only that blank is cleared', async () => {
    const home = makeRoot('blank-link-sleep');
    const ctx = sleepCtx(home, 0);
    const moved = aged('the nightly build runs at two in the morning');
    const current = aged('the cache layer is warmed before the release train');
    const decayed = decayedStrength(ctx, current);
    expect(decayed).not.toBe(moved.strength);
    writeEntry(home, moved);
    writeEntry(home, { ...current, strength: decayed });
    blankBySql(home, moved.id);
    blankBySql(home, current.id);

    await api.sleepWholeStore(ctx, { noShare: true });

    expect(storedLink(home, moved.id)).toEqual(NO_LINK);
    expect(storedLink(home, current.id)).toEqual(BLANK_LINK);
  });

  it('also clears a blank row its replay pass rehearses, whatever its strength', async () => {
    const home = makeRoot('blank-link-replay');
    const ctx = sleepCtx(home, 5);
    const entry = aged('the cache layer is warmed before the release train');
    writeEntry(home, { ...entry, strength: decayedStrength(ctx, entry) });
    blankBySql(home, entry.id);

    await api.sleepWholeStore(ctx, { noShare: true });

    expect(storedLink(home, entry.id)).toEqual(NO_LINK);
  });
});
