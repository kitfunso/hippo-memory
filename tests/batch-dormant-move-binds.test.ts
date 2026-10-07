/** batchWriteAndDelete binds one value per placeholder when the same memory is queued for a dormant move twice. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '../src/db/sqlite.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry } from '../src/store/entry-reads.js';
import { batchWriteAndDelete } from '../src/store/delete-and-batch.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// node:sqlite binds a missing value as NULL; a strict driver throws, so the test counts the binds itself.
function recordInListBinds(): Array<{ placeholders: number; values: number }> {
  const seen: Array<{ placeholders: number; values: number }> = [];
  type Preparer = { prepare(sql: string): { all(...p: unknown[]): unknown[] } };
  // SAFETY: DatabaseSync.prototype carries prepare(), and its statements carry all().
  const proto = DatabaseSync.prototype as Preparer;
  const realPrepare = proto.prepare;
  vi.spyOn(proto, 'prepare').mockImplementation(function (this: Preparer, sql: string) {
    const stmt = realPrepare.call(this, sql);
    if (!sql.includes('FROM memories WHERE id IN (')) return stmt;
    return {
      all: (...params: unknown[]) => {
        seen.push({ placeholders: (sql.match(/\?/g) ?? []).length, values: params.length });
        return stmt.all(...params);
      },
    };
  });
  return seen;
}

it('a memory queued for a dormant move twice binds every placeholder and moves once', () => {
  const root = mkdtempSync(join(tmpdir(), 'hippo-dormant-binds-'));
  roots.push(root);
  initStore(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ replay: { count: 0 } }));
  const entry = createMemory('the nightly export writes to the cold bucket in eu-west-2', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  writeEntry(root, entry);
  const move = { entry, strength: 0.01, reason: 'decay' as const, dormantAt: new Date().toISOString() };

  const binds = recordInListBinds();
  expect(batchWriteAndDelete(root, [], [], { dormant: [move, { ...move }] })).toEqual([entry.id]);

  expect(binds.length).toBeGreaterThan(0);
  for (const b of binds) expect(b.values).toBe(b.placeholders);
  expect(readEntry(root, entry.id)).toBeNull();
});
