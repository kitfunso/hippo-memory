// A graph rebuild prepares a fixed set of statements however many ops it applies, and checks each endpoint once.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { applyGraphOpsAt } from '../../src/store/graph-apply.js';
import { loadRelations } from '../../src/store/graph-reads.js';
import type { GraphOp, NaturalKey } from '../../src/store/port/graph-rebuild.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; prepare takes SQL text and returns a statement.
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: { prototype: { prepare(sql: string): object } } };

/** Two entities and one relation per decision: the ops a rebuild of `count` new decisions applies. */
function rebuildOps(decisionIds: readonly number[]): GraphOp[] {
  const keyOf = (id: number, entityType: NaturalKey['entityType']): NaturalKey => ({
    entityType,
    sourceObject: { type: 'decision', id },
  });
  return [
    ...decisionIds.flatMap((id): GraphOp[] => [
      { op: 'insertEntity', entity: { ...keyOf(id, 'decision'), name: `decision ${id}`, memoryId: null } },
      { op: 'insertEntity', entity: { ...keyOf(id, 'person'), name: `owner ${id}`, memoryId: null } },
    ]),
    ...decisionIds.map((id): GraphOp => ({
      op: 'insertRelation',
      relation: {
        from: keyOf(id, 'person'),
        to: keyOf(id, 'decision'),
        relType: 'owns',
        memoryId: null,
        sourceObject: { type: 'decision', id },
      },
    })),
  ];
}

/** Applies a rebuild of `count` decisions on a fresh store and handle; returns the prepares and statements it ran. */
function applyFresh(count: number) {
  const root = makeRoot(`graph-apply-${count}`);
  const db = openHippoDb(root);
  try {
    const insert = db.prepare(`INSERT INTO decisions(tenant_id, decision_text, created_at) VALUES ('default', ?, ?)`);
    const ids = Array.from({ length: count }, (_, i) =>
      Number(insert.run(`decision ${i}`, '2026-01-01T00:00:00.000Z').lastInsertRowid),
    );
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    try {
      const { result, statements } = recordStatements(() =>
        applyGraphOpsAt(db, 'default', rebuildOps(ids), { from: 0, holdMs: Infinity }),
      );
      return { result, statements, prepares: prepare.mock.calls.length, root };
    } finally {
      prepare.mockRestore();
    }
  } finally {
    closeHippoDb(db);
  }
}

describe('applyGraphOpsAt', () => {
  it('prepares the same statements for 2 decisions as for 12', () => {
    const small = applyFresh(2);
    const large = applyFresh(12);

    expect(small.result).toEqual({ next: 6, skipped: 0 });
    expect(large.result).toEqual({ next: 36, skipped: 0 });
    expect(loadRelations(large.root, 'default', { limit: 100 })).toHaveLength(12);
    expect(large.prepares).toBe(small.prepares);
  });

  it('checks each relation endpoint once, by the natural-key lookup, and does not read the relation back', () => {
    const { statements } = applyFresh(5);

    expect(countMatching(statements, 'SELECT tenant_id FROM entities')).toBe(0);
    expect(countMatching(statements, /FROM relations WHERE id = \?/)).toBe(0);
    expect(countMatching(statements, /^INSERT INTO relations/)).toBe(5);
  });
});
