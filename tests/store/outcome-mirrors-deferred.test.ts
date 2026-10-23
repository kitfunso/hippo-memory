// Outcome mirrors leave the job: marks commit with the rows, a pass after the job rewrites them, and a store opened
// after a crash rewrites whatever its marks still name.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeRoot } from '../_helpers/make-root.js';
import { closeHippoDb, openHippoDb, withWriteScope, type DatabaseSyncLike } from '../../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { serializeEntry } from '../../src/base/memory/markdown.js';
import { applyOutcome, writeEntriesTogether, writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { selectEntriesByIds } from '../../src/store/sqlite/entry-reads.js';
import { markMirrorsDue } from '../../src/store/sqlite/due-mirrors.js';
import { flushHeldMirrors } from '../../src/store/sqlite/mirrors.js';
import { openStore, storeFilesOf } from '../../src/store/sqlite/handles.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';

const open: DatabaseSyncLike[] = [];
afterEach(() => {
  for (const db of open.splice(0)) closeHippoDb(db);
});

function memory(i: number, layer: Layer): MemoryEntry {
  return createMemory(`deferred mirror row ${i} about the quillwort ledger`, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer,
  });
}

function mirrorText(root: string, entry: MemoryEntry): string | null {
  const file = path.join(root, entry.layer, `${entry.id}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Each mirror as its row now stands. */
function rowTexts(db: DatabaseSyncLike, entries: readonly MemoryEntry[]): string[] {
  const rows = selectEntriesByIds(
    db,
    entries.map((entry) => entry.id),
    ALL_TENANTS,
  );
  return entries.map((entry) => serializeEntry(rows.get(entry.id)!));
}

function dueKeys(db: DatabaseSyncLike): string[] {
  // SAFETY: the SELECT names one TEXT column, key.
  const rows = db.prepare(`SELECT key FROM meta WHERE key LIKE 'mirror_due:%' ORDER BY key`).all() as Array<{
    key: string;
  }>;
  return rows.map((row) => row.key);
}

describe('outcome mirrors', () => {
  it('are left to a pass after the job, which brings each in step with its row and clears its mark', () => {
    const root = makeRoot('due-mirror-outcome');
    const db = openStore(root);
    open.push(db);
    const entries = [memory(1, Layer.Episodic), memory(2, Layer.Semantic)];
    writeEntriesTogether(db, storeFilesOf(root), entries);
    const before = entries.map((entry) => mirrorText(root, entry));
    const ids = entries.map((entry) => entry.id);
    applyOutcome(db, storeFilesOf(root), {
      tenantId: 'default',
      actor: 'test',
      ownScope: null,
      role: 'admin',
      ids,
      good: true,
    });

    expect(entries.map((entry) => mirrorText(root, entry))).toEqual(before);
    expect(dueKeys(db)).toEqual(ids.map((id) => `mirror_due:${id}`).sort());
    flushHeldMirrors(root);
    const after = entries.map((entry) => mirrorText(root, entry));
    expect(after).not.toEqual(before);
    expect(after).toEqual(rowTexts(db, entries));
    expect(dueKeys(db)).toEqual([]);
  });

  it('a crash left due are rewritten when the store next opens, and a mark whose row is gone is cleared', () => {
    const root = makeRoot('due-mirror-crash', { init: false });
    const entry = memory(3, Layer.Episodic);
    // A process that committed the outcome and died before its pass: the row and its mark, with no mirror.
    const crashed = openHippoDb(root);
    try {
      withWriteScope(crashed, 'crashed_outcome', () => {
        writeEntryDbOnly(crashed, entry);
        markMirrorsDue(crashed, [entry.id, 'mem_gone']);
      });
    } finally {
      closeHippoDb(crashed);
    }
    expect(mirrorText(root, entry)).toBeNull();

    const db = openStore(root);
    open.push(db);
    expect(mirrorText(root, entry)).toBe(rowTexts(db, [entry])[0]);
    expect(dueKeys(db)).toEqual([]);
  });
});
