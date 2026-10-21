// Every hippo.db write path refuses an id another tenant holds and leaves that tenant's row as it was.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { ConflictError } from '../../src/base/errors/api-errors.js';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import type { DatabaseSyncLike } from '../../src/db/index.js';
import {
  writeEntriesSkippingRejectedAt,
  writeEntriesTogetherAt,
  writeEntryAt,
  writeEntryDbOnly,
  writePromotedEntryAt,
} from '../../src/store/sqlite/entry-writes.js';
import { onHandle, openStore } from '../../src/store/sqlite/handles.js';
import type { StoreFiles } from '../../src/store/sqlite/open.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// SAFETY: the SELECT below names exactly these three columns.
type Row = { tenant_id: string; content: string; strength: number };
const rowOf = (db: DatabaseSyncLike, id: string) =>
  db.prepare('SELECT tenant_id, content, strength FROM memories WHERE id = ?').get(id) as Row | undefined;

function intruderOf(a: MemoryEntry): MemoryEntry {
  return { ...a, tenantId: 'tenant-b', content: 'taken over', strength: 0.123 };
}

function withHeldRow(run: (db: DatabaseSyncLike, files: StoreFiles, a: MemoryEntry, b: MemoryEntry) => void): void {
  const root = makeRoot('entry-writes-cross-tenant');
  roots.push(root);
  const a = createMemory('tenant a row', { tenantId: 'tenant-a' });
  onHandle(
    root,
    (db) => {
      writeEntryDbOnly(db, a);
      run(db, { hippoRoot: root }, a, intruderOf(a));
      expect(rowOf(db, a.id)).toEqual({
        tenant_id: 'tenant-a',
        content: 'tenant a row',
        strength: a.strength,
      });
    },
    openStore,
  );
}

describe('a write of an id another tenant holds', () => {
  it('is refused by writeEntryAt', () => {
    withHeldRow((db, files, _a, b) => expect(() => writeEntryAt(db, files, b)).toThrow(ConflictError));
  });

  it('is refused by writePromotedEntryAt', () => {
    withHeldRow((db, files, a, b) =>
      expect(() => writePromotedEntryAt(db, files, b, { sourceId: a.id })).toThrow(ConflictError),
    );
  });

  it('fails writeEntriesTogetherAt whole, so a clean row beside it does not land', () => {
    withHeldRow((db, files, _a, b) => {
      const clean = createMemory('clean row', { tenantId: 'tenant-b' });
      expect(() => writeEntriesTogetherAt(db, files, [clean, b])).toThrow(ConflictError);
      expect(rowOf(db, clean.id)).toBeUndefined();
    });
  });

  it('is skipped by writeEntriesSkippingRejectedAt while the rest of the batch lands', () => {
    withHeldRow((db, files, _a, b) => {
      const clean = createMemory('clean row', { tenantId: 'tenant-b' });
      const put: boolean[] = [];
      const count = writeEntriesSkippingRejectedAt(db, files, (write) => {
        put.push(write(b), write(clean));
      });
      expect(put).toEqual([false, true]);
      expect(count).toBe(1);
      expect(rowOf(db, clean.id)?.tenant_id).toBe('tenant-b');
    });
  });
});
