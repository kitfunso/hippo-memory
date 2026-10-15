// The Sessions, Cards, Goals, Conflicts, Dormant and Reports groups answer alike as sqliteX (sync) and servedX (async), on a real store.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { replaceDetectedConflicts } from '../src/store/conflicts.js';
import { insertDormantRow } from '../src/store/dormant.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { sqliteSyncStore, sqliteStore } from '../src/store/sqlite/store.js';
import { makeRoot } from './_helpers/make-root.js';

const T = 'default';
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function root(): string {
  const made = makeRoot('session-admin-groups');
  roots.push(made);
  return made;
}

const entry = (text: string) => createMemory(text, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: T });

describe('sessions group', () => {
  it('keeps a snapshot, events and a handoff, in both forms', async () => {
    const r = root();
    const sync = sqliteSyncStore(r).sessions;
    const served = sqliteStore(r).sessions;
    const snap = { task: 'ship', summary: 'half done', next_step: 'merge', session_id: 's1' };
    expect(sync.saveSnapshot(T, snap, null).task).toBe('ship');
    expect((await served.loadSnapshot(T, null))?.next_step).toBe('merge');
    await served.appendEvent(T, { session_id: 's1', event_type: 'note', content: 'hello' });
    expect((await served.listEvents(T, { sessionId: 's1' })).map((e) => e.content)).toEqual(['hello']);
    expect(sync.listEvents(T, { sessionId: 's1' })).toHaveLength(1);
    const handoff = await served.saveHandoff(T, { version: 1, sessionId: 's1', summary: 'carry on' }, null);
    expect(handoff.summary).toBe('carry on');
    expect((await served.latestHandoff(T, 's1', {}, null))?.summary).toBe('carry on');
    expect(await served.clearSnapshot(T, 'done')).toBe(true);
  });

  it('pushes, reads and clears working memory', async () => {
    const r = root();
    const served = sqliteStore(r).sessions;
    await served.pushWorkingMemory(T, { scope: 'task', content: 'note one' });
    expect((await served.readWorkingMemory(T, { scope: 'task', limit: 10 })).map((i) => i.content)).toEqual(['note one']);
    expect(await served.clearWorkingMemory(T, { scope: 'task' })).toBe(1);
  });
});

describe('cards group', () => {
  it('runs a card from create to complete in both forms', async () => {
    const r = root();
    const sync = sqliteSyncStore(r).cards;
    const served = sqliteStore(r).cards;
    const card = sync.create(T, { title: 'wire the port' });
    expect((await served.load(T, card.id))?.title).toBe('wire the port');
    const claimed = await served.claim(T, card.id, 'claude');
    expect(claimed?.runId).toBeGreaterThan(0);
    await served.comment(T, card.id, 'me', 'looks good');
    const detail = await served.detail(T, card.id);
    expect(detail?.comments).toHaveLength(1);
    expect(detail?.runs).toHaveLength(1);
    expect(sync.list(T, {}).map((c) => c.id)).toContain(card.id);
    expect(await served.load(T, 'nope')).toBeNull();
    expect(() => sync.create(T, { title: '' })).toThrow();
    await expect(served.create(T, { title: '' })).rejects.toThrow();
  });
});

describe('goals group', () => {
  it('pushes a goal and lists it, then completes it', async () => {
    const r = root();
    const sync = sqliteSyncStore(r).goals;
    const served = sqliteStore(r).goals;
    const goal = sync.push(T, { sessionId: 's1', goalName: 'ship the refactor' });
    expect((await served.sessionGoals(T, 's1')).map((g) => g.id)).toEqual([goal.id]);
    await served.suspend(T, goal.id);
    await served.resume(T, goal.id);
    await served.complete(T, goal.id, { outcomeScore: 1 });
    expect(sync.sessionGoals(T, 's1')[0]?.status).toBe('completed');
  });
});

describe('conflicts group', () => {
  it('lists an open conflict and resolves it', async () => {
    const r = root();
    const a = entry('deploys run from main');
    const b = entry('deploys never run from main');
    writeEntry(r, a);
    writeEntry(r, b);
    replaceDetectedConflicts(r, [{ memory_a_id: a.id, memory_b_id: b.id, reason: 'contradiction', score: 0.9 }]);
    const sync = sqliteSyncStore(r).conflicts;
    const served = sqliteStore(r).conflicts;
    const [open] = sync.list(T, 'open');
    expect(open).toBeDefined();
    expect(await served.list(null, 'open')).toHaveLength(1);
    expect(await served.list('other', 'open')).toHaveLength(0);
    const resolved = await served.resolve(T, { conflictId: open!.id, keepId: a.id }, {});
    expect(resolved?.loserId).toBe(b.id);
    expect(await served.list(T, 'open')).toHaveLength(0);
  });
});

describe('dormant group', () => {
  function seed(r: string) {
    const row = entry('the staging host was build-07');
    const db = openHippoDb(r);
    try {
      insertDormantRow(db, { entry: row, strength: 0.01, reason: 'decay', dormantAt: new Date().toISOString() });
    } finally { closeHippoDb(db); }
    return row;
  }

  it('lists, restores and forgets, and keeps another tenant out', async () => {
    const r = root();
    const row = seed(r);
    const sync = sqliteSyncStore(r).dormant;
    const served = sqliteStore(r).dormant;
    expect(sync.list(T, null, {}).map((m) => m.id)).toEqual([row.id]);
    expect(await served.holds(T, null, row.id)).toBe(true);
    expect(await served.holds('other', null, row.id)).toBe(false);
    const outcome = await served.restore(T, { id: row.id, actor: 'me', inReach: () => true, revive: (s) => s.entry });
    expect(outcome.status).toBe('restored');
    expect(await served.list(T, null, {})).toEqual([]);
  });

  it('forget deletes the row and answers false for a missing id', async () => {
    const r = root();
    const row = seed(r);
    const served = sqliteStore(r).dormant;
    expect(await served.forget(T, null, row.id, 'me')).toBe(true);
    expect(await served.forget(T, null, row.id, 'me')).toBe(false);
  });
});

describe('reports group', () => {
  it('tallies strength and open conflicts on one snapshot and pages entries', async () => {
    const r = root();
    const a = entry('first note');
    const b = entry('second note');
    writeEntry(r, a);
    writeEntry(r, b);
    replaceDetectedConflicts(r, [{ memory_a_id: a.id, memory_b_id: b.id, reason: 'x', score: 0.9 }]);
    const sync = sqliteSyncStore(r).reports;
    const served = sqliteStore(r).reports;
    const status = await served.memoryStatus(T, new Date(), 0.1);
    expect(status).toMatchObject({ total: 2, openConflicts: 1 });
    expect(sync.memoryStatus(T, new Date(), 0.1).total).toBe(2);
    const first = await served.entriesPage(T, { limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.next).not.toBeNull();
    expect((await served.entriesPage(null, { limit: 10 })).entries).toHaveLength(2);
    expect(await served.countEntries()).toBe(2);
    expect((await served.tokenUse(T, '2020-01-01T00:00:00.000Z')).totalTokens).toBe(0);
    expect(await served.failures(T, '2020-01-01T00:00:00.000Z')).toBeDefined();
  });
});
