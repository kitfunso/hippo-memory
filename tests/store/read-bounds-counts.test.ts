// Session assembly and batch delete do work bounded by what the caller needs: counted in statements and rows, never timed.
import { afterEach, describe, expect, it } from 'vitest';
import { assemble } from '../../src/api/index.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { MEMORY_SELECT_COLUMNS } from '../../src/store/sqlite/runtime/rows.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { countMatching, peakRowsRead, recordStatements, recordStatementsAsync } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { batchWriteAndDeleteInFolder, writeEntriesTogether } from '../_helpers/root-forms.js';

const FULL_ROW = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories`;
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) removeDir(r);
});

function raw(i: number, session: string, scope: string | null): MemoryEntry {
  return {
    ...createMemory(`message body number ${i} with some words to fill a line`, {
      layer: Layer.Buffer,
      kind: 'raw',
      scope,
      sourceSessionId: session,
    }),
    id: `${scope ? 'hid' : 'open'}-${String(i).padStart(5, '0')}`,
    created: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  };
}

function seeded(open: number, hidden: number): string {
  const root = makeRoot('read-bounds');
  roots.push(root);
  writeEntriesTogether(root, [
    ...Array.from({ length: open }, (_, i) => raw(i, 's1', null)),
    ...Array.from({ length: hidden }, (_, i) => raw(open + i, 's1', 'slack:private:CSEC')),
  ]);
  return root;
}

const ctxOf = (root: string) => apiCtx(root, 'default', { subject: 'test:read-bounds', role: 'admin' });

describe('assemble reads', () => {
  it('reads no more rows for a session with out-of-scope rows than without', async () => {
    const alone = seeded(60, 0);
    const mixed = seeded(60, 400);
    const a = await recordStatementsAsync(() => assemble(ctxOf(alone), 's1'));
    const m = await recordStatementsAsync(() => assemble(ctxOf(mixed), 's1'));
    expect(m.result.totalRaw).toBe(60);
    expect(m.rowsRead).toBe(a.rowsRead);
    expect(m.statements.length).toBe(a.statements.length);
  });

  it('applies the cap to the rows the caller may see', async () => {
    // The hidden rows are the newest, so a cap taken before the scope rule would leave no visible row.
    const root = seeded(30, 0);
    writeEntriesTogether(
      root,
      Array.from({ length: 50 }, (_, i) => ({
        ...raw(1000 + i, 's1', 'slack:private:CSEC'),
        created: new Date(Date.UTC(2027, 0, 1) + i * 1000).toISOString(),
      })),
    );
    const r = await assemble(ctxOf(root), 's1', { rowCap: 20, budget: 100000 });
    expect(r.items).toHaveLength(20);
    expect(r.truncated).toBe(true);
    expect(r.totalRaw).toBe(30);
  });

  it('loads only the rows the token budget keeps, however long the session', async () => {
    const small = await recordStatementsAsync(() => assemble(ctxOf(seeded(30, 0)), 's1', { budget: 200 }));
    const long = await recordStatementsAsync(() => assemble(ctxOf(seeded(90, 0)), 's1', { budget: 200 }));
    expect(long.result.evicted).toBeGreaterThan(55);
    expect(peakRowsRead(small.reads, FULL_ROW)).toBe(small.result.items.length);
    expect(peakRowsRead(long.reads, FULL_ROW)).toBe(long.result.items.length);
    expect(long.result.items.length).toBe(small.result.items.length);
  });

  it('keeps the budget when content carries characters wider than one UTF-16 unit', async () => {
    const root = makeRoot('read-bounds-wide');
    roots.push(root);
    writeEntriesTogether(
      root,
      Array.from({ length: 40 }, (_, i) => ({
        ...raw(i, 's1', null),
        content: `${'\u{1F600}'.repeat(30)} number ${i}`,
      })),
    );
    const r = await assemble(ctxOf(root), 's1', { budget: 300 });
    expect(r.tokens).toBeLessThanOrEqual(300);
    expect(r.evicted).toBeGreaterThan(0);
  });
});

describe('batch delete', () => {
  it('runs the same number of DELETE statements however many rows go', () => {
    const counts = [5, 120].map((n) => {
      const root = makeRoot('batch-delete-count');
      roots.push(root);
      // A raw row is never deleted automatically, so the rows are distilled.
      const rows = Array.from({ length: n }, (_, i) => ({
        ...createMemory(`note number ${i} about topic ${i * 31}`),
        id: `note-${String(i).padStart(4, '0')}`,
      }));
      writeEntriesTogether(root, rows);
      const { statements } = recordStatements(() =>
        batchWriteAndDeleteInFolder(
          root,
          [],
          rows.map((r) => r.id),
        ),
      );
      return countMatching(statements, 'DELETE FROM memories WHERE id');
    });
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(counts[0]);
  });
});
