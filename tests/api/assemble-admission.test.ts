// Session assemble reads its window's content under the same session, scope and live-row rule it chose the window by.
import { afterEach, describe, expect, it } from 'vitest';
import { assemble } from '../../src/api/index.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { loadFreshRawMemories, writeEntriesTogether } from '../_helpers/root-forms.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) removeDir(r);
});

function raw(i: number): MemoryEntry {
  return {
    ...createMemory(`message body number ${i} with some words to fill a line`, {
      layer: Layer.Buffer,
      kind: 'raw',
      sourceSessionId: 's1',
    }),
    id: `raw-${String(i).padStart(3, '0')}`,
    created: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  };
}

function seeded(n: number): string {
  const root = makeRoot('assemble-admission');
  roots.push(root);
  writeEntriesTogether(
    root,
    Array.from({ length: n }, (_, i) => raw(i)),
  );
  return root;
}

function sql(root: string, statement: string, ...params: string[]): void {
  const db = openHippoDb(root);
  try {
    db.prepare(statement).run(...params);
  } finally {
    closeHippoDb(db);
  }
}

const member = (root: string) => apiCtx(root, 'default', { subject: 'test:member', role: 'member' });

describe('assemble admission', () => {
  it('leaves out a row made private between choosing the window and reading its content', async () => {
    const root = seeded(5);
    const ctx = member(root);
    const dagReads = ctx.store.dagReads;
    const raced = {
      ...ctx,
      store: {
        ...ctx.store,
        dagReads: {
          ...dagReads,
          sessionRawKeys: async (query: Parameters<typeof dagReads.sessionRawKeys>[0]) => {
            const keys = await dagReads.sessionRawKeys(query);
            sql(root, `UPDATE memories SET scope = 'slack:private:CSEC' WHERE id = ?`, 'raw-002');
            return keys;
          },
        },
      },
    };
    const r = await assemble(raced, 's1', { budget: 100000 });
    expect(r.items.map((it) => it.id)).not.toContain('raw-002');
    expect(r.items).toHaveLength(4);
  });

  it('assembles and counts a raw row whose superseded_by is blank, as every live-row read does', async () => {
    const root = seeded(3);
    sql(root, `UPDATE memories SET superseded_by = '' WHERE id = ?`, 'raw-001');
    const whole = await assemble(member(root), 's1', { budget: 100000 });
    expect(whole.items.map((it) => it.id)).toEqual(['raw-000', 'raw-001', 'raw-002']);
    // A capped window reports the uncapped count, read by sessionRawCount.
    const capped = await assemble(member(root), 's1', { budget: 100000, rowCap: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.totalRaw).toBe(3);
    // The recall fresh tail reads the same session's raw rows by the same rule.
    expect(loadFreshRawMemories(root, 10, 'default', 's1').map((r) => r.id)).toContain('raw-001');
  });
});
