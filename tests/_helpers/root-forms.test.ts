// The paging and pairing helpers 519 tests lean on: a wrong page join or conflict side would pass unnoticed there.
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { makeRoot } from './make-root.js';
import {
  deleteEntry,
  listMemoryConflicts,
  loadAllEntries,
  loadEntryTextKeys,
  loadEveryTenantEntries,
  readEntry,
  replaceDetectedConflicts,
  resolveConflictKeeping,
  writeEntriesTogether,
  writeEntry,
} from './root-forms.js';

let root: string;
const row = (text: string, tenantId = 'default') =>
  createMemory(text, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId });

beforeEach(() => {
  root = makeRoot('root-forms', { config: { embeddings: { enabled: false } } });
});

describe('entries', () => {
  it('writes, reads and deletes one row', () => {
    const entry = row('the staging database moved to the eu-central region');
    writeEntry(root, entry);
    expect(readEntry(root, entry.id)?.content).toBe(entry.content);
    expect(deleteEntry(root, entry.id)).toBe(true);
    expect(readEntry(root, entry.id)).toBeNull();
    expect(deleteEntry(root, entry.id)).toBe(false);
  });

  it('writes a batch together and reports how many landed', () => {
    const rows = ['one note about caches', 'two notes about queues', 'three notes about locks'].map((t) => row(t));
    expect(writeEntriesTogether(root, rows)).toBe(3);
    expect(
      loadAllEntries(root, 'default')
        .map((e) => e.id)
        .sort(),
    ).toEqual(rows.map((r) => r.id).sort());
  });

  it('reads one tenant, or every tenant when the test names none', () => {
    const a = row('tenant a keeps its deploy window on tuesday', 'tenant-a');
    const b = row('tenant b keeps its deploy window on friday', 'tenant-b');
    writeEntriesTogether(root, [a, b]);
    expect(readEntry(root, a.id, 'tenant-b')).toBeNull();
    expect(readEntry(root, a.id)?.id).toBe(a.id);
    expect(
      loadEveryTenantEntries(root)
        .map((e) => e.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('joins every text-key page whatever the page size', () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(`distinct note number ${i} on the release train`));
    writeEntriesTogether(root, rows);
    const whole = loadEntryTextKeys(root);
    const paged = loadEntryTextKeys(root, undefined, 2);
    expect(whole).toHaveLength(7);
    expect(paged).toEqual(whole);
  });
});

describe('conflicts', () => {
  const seed = () => {
    const [x, y, z] = ['always use port 3000', 'never use port 3000', 'prefer port 4000'].map((t) =>
      row(`${t} for the dev server`),
    );
    writeEntriesTogether(root, [x!, y!, z!]);
    replaceDetectedConflicts(root, [{ memory_a_id: x!.id, memory_b_id: y!.id, reason: 'contradiction', score: 0.9 }]);
    return { x: x!, y: y! };
  };

  it('lists open conflicts and none under another status', async () => {
    const { x, y } = seed();
    expect((await listMemoryConflicts(root)).map((c) => [c.memory_a_id, c.memory_b_id])).toEqual([[x.id, y.id].sort()]);
    expect(await listMemoryConflicts(root, 'resolved')).toEqual([]);
  });

  it('resolves in favour of either side and weakens the other', async () => {
    const { x, y } = seed();
    const [conflict] = await listMemoryConflicts(root);
    expect(await resolveConflictKeeping(root, 'default', conflict!.id, y.id)).toBe(true);
    expect(await listMemoryConflicts(root)).toEqual([]);
    expect(await listMemoryConflicts(root, 'resolved')).toHaveLength(1);
    expect(readEntry(root, x.id)?.halfLifeDays).toBe(DEFAULT_HALF_LIFE_DAYS / 2);
    expect(readEntry(root, y.id)?.halfLifeDays).toBe(DEFAULT_HALF_LIFE_DAYS);
  });

  it('returns false for a conflict that does not exist', async () => {
    expect(await resolveConflictKeeping(root, 'default', 999, 'mem_none')).toBe(false);
  });
});
