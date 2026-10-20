import { describe, it, expect, beforeEach } from 'vitest';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb, withSharedStoreHandles } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeStore } from '../_helpers/make-root.js';
import { loadAmbientCandidates, writeEntriesTogether, writeEntry } from '../_helpers/root-forms.js';
import { recordStatements } from '../_helpers/count-statements.js';

const BASE = Date.parse('2026-06-01T00:00:00.000Z');
const MINUTE = 60_000;

function row(id: string, minute: number): MemoryEntry {
  const at = new Date(BASE + minute * MINUTE).toISOString();
  return { ...createMemory(`row ${id} body`, { tenantId: 'default' }), id, created: at, validFrom: at };
}

function rawCreated(root: string, id: string): string {
  const db = openHippoDb(root);
  try {
    return (db.prepare('SELECT created FROM memories WHERE id = ?').get(id) as { created: string }).created;
  } finally {
    closeHippoDb(db);
  }
}

// Writers store toISOString text now, so the stamps older importers left are put back by hand.
function plant(root: string, stamps: Record<string, string>): void {
  const db = openHippoDb(root);
  try {
    const update = db.prepare('UPDATE memories SET created = ? WHERE id = ?');
    for (const [id, created] of Object.entries(stamps)) update.run(created, id);
  } finally {
    closeHippoDb(db);
  }
}

// contextGet's order: the instant Date reads, then id, newest first.
function wholeReadNewest(root: string, admit: (e: Pick<MemoryEntry, 'id'>) => boolean, n: number): string[] {
  const db = openHippoDb(root);
  try {
    const rows = db.prepare('SELECT id, created FROM memories WHERE superseded_by IS NULL').all() as Array<{
      id: string;
      created: string;
    }>;
    const at = (c: string) => (Number.isNaN(Date.parse(c)) ? -Infinity : Date.parse(c));
    return rows
      .sort((a, b) => at(b.created) - at(a.created) || (a.id < b.id ? 1 : -1))
      .filter((r) => admit(r))
      .slice(0, n)
      .map((r) => r.id);
  } finally {
    closeHippoDb(db);
  }
}

const ids = (entries: readonly MemoryEntry[]) => entries.map((e) => e.id).sort();

const instant = (e: MemoryEntry) => (Number.isNaN(Date.parse(e.created)) ? -Infinity : Date.parse(e.created));
const newest = (entries: readonly MemoryEntry[], n: number) =>
  [...entries]
    .sort((a, b) => instant(b) - instant(a) || (a.id < b.id ? 1 : -1))
    .slice(0, n)
    .map((e) => e.id);

describe('the row writer stores created as toISOString text', () => {
  it('normalizes an offset stamp and keeps one Date cannot read as written', () => {
    const root = makeStore('drift-writer').root;
    writeEntry(root, { ...row('offset', 0), created: '2026-03-05T10:00:00+01:00' });
    writeEntry(root, { ...row('zoneless', 0), created: '2026-03-05 10:00:00' });
    writeEntry(root, { ...row('unreadable', 0), created: 'not a date' });
    expect(rawCreated(root, 'offset')).toBe('2026-03-05T09:00:00.000Z');
    // Date reads a zoneless stamp in local time, so the stored instant is the one every reader already sorted by.
    expect(rawCreated(root, 'zoneless')).toBe(new Date('2026-03-05 10:00:00').toISOString());
    expect(rawCreated(root, 'unreadable')).toBe('not a date');
  });
});

describe('the ambient recent read with legacy stamps still in the store', () => {
  let root: string;
  const legacy = {
    // Newest of all by instant, though its text sorts below every ISO stamp of the same day.
    'r-offset': '2026-06-01 09:00:00+00:00',
    // Inside the window by instant, written with a space and an offset.
    'r-spaced': new Date(BASE + 35.5 * MINUTE).toISOString().replace('T', ' ').replace('Z', '+00:00'),
    'r-unreadable': 'garbage',
  };

  beforeEach(async () => {
    root = makeStore('drift-ambient').root;
    await withSharedStoreHandles(() => {
      writeEntriesTogether(root, [
        ...Array.from({ length: 40 }, (_, i) => row(`r${String(i).padStart(2, '0')}`, i)),
        ...Object.keys(legacy).map((id) => row(id, -500)),
      ]);
    });
    plant(root, legacy);
  });

  it('returns the window a whole read sorted by instant returns', () => {
    const all = () => true;
    // The first window is max(4 * 5, 32) rows, all kept, so the load returns all of them.
    expect(ids(loadAmbientCandidates(root, 'default', 5, all).entries)).toEqual(wholeReadNewest(root, all, 32).sort());
    expect(ids(loadAmbientCandidates(root, 'default', 5, all).entries)).toContain('r-offset');
    // Refusing the newest rows walks keyset pages past the first window, still by instant.
    const old = (e: Pick<MemoryEntry, 'id'>) => e.id < 'r05' || e.id === 'r-spaced';
    const kept = loadAmbientCandidates(root, 'default', 4, old).entries;
    // The page past the window is 128 rows, more than the store holds, so every admitted row comes back.
    expect(ids(kept)).toEqual(wholeReadNewest(root, old, 160).sort());
    expect(newest(kept, 4)).toEqual(wholeReadNewest(root, old, 4));
  });

  it('reads the same rows when the store holds five times more older rows', async () => {
    const all = () => true;
    const before = recordStatements(() => loadAmbientCandidates(root, 'default', 5, all));
    await withSharedStoreHandles(() => {
      writeEntriesTogether(
        root,
        Array.from({ length: 200 }, (_, i) => row(`old${i}`, -1000 - i)),
      );
    });
    const after = recordStatements(() => loadAmbientCandidates(root, 'default', 5, all));
    expect(ids(after.result.entries)).toEqual(ids(before.result.entries));
    expect(after.rowsRead).toBe(before.rowsRead);
    expect(after.statements.length).toBe(before.statements.length);
  });
});
