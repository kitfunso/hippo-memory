// A blank superseded link goes into dormant storage as written, and a restore stores no link, so the memory is live
// again. Its own file since tests/store/dormant-memories.test.ts sits at the 800-line cap.
import { describe, expect, it } from 'vitest';
import * as api from '../../src/api/index.js';
import { isSuperseded } from '../../src/base/memory/liveness.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { batchWriteAndDeleteInFolder } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, readEntry, sessionDb, sqliteStore, apiCtx } = sessionPerTest();

describe('a blank superseded link through dormant storage', () => {
  it('moves to dormant as written, and a restore stores no link and returns the memory to the live read', async () => {
    const home = makeRoot('dormant-blank-link');
    const entry = createMemory('the release train leaves on thursdays');
    writeEntry(home, entry);
    sessionDb(home).prepare(`UPDATE memories SET superseded_by = '' WHERE id = ?`).run(entry.id);
    const move = {
      entry: readEntry(home, entry.id)!,
      strength: 0.01,
      reason: 'decay' as const,
      dormantAt: '2026-01-01T00:00:00.000Z',
    };

    expect(batchWriteAndDeleteInFolder(home, [], [], { dormant: [move] })).toEqual([entry.id]);
    expect(readEntry(home, entry.id)).toBeNull();
    // Only the restore normalises: the snapshot keeps what the row held.
    const snapshot = sessionDb(home)
      .prepare(`SELECT json_extract(entry_json, '$.superseded_by') AS link FROM dormant_memories WHERE id = ?`)
      .get(entry.id);
    expect(snapshot).toEqual({ link: '' });
    await api.dormantRestore(apiCtx(home, 'default', { subject: 'test', role: 'admin' }), entry.id);

    const stored = sessionDb(home).prepare('SELECT superseded_by FROM memories WHERE id = ?').get(entry.id);
    expect(stored).toEqual({ superseded_by: null });
    const back = readEntry(home, entry.id)!;
    expect(isSuperseded(back)).toBe(false);
    const live = await sqliteStore(home).entriesWhere({ tenantId: 'default', live: true }, { limit: 10 });
    expect(live.entries.map((e) => e.id)).toContain(entry.id);
  });
});
