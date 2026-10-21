// A refresh that resolves stale open conflicts reads them in pages and writes one UPDATE per page, not one per row.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { replaceDetectedConflicts, writeEntriesTogether } from '../_helpers/root-forms.js';

const PAIRS = 700;
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('resolving stale open conflicts', () => {
  it('resolves every stale row with one UPDATE per page', () => {
    const root = makeRoot('stale-conflicts');
    roots.push(root);
    const entries = Array.from({ length: PAIRS * 2 }, (_, i) => ({
      ...createMemory(`conflict member ${i}`),
      id: `mem_c${String(i).padStart(5, '0')}`,
    }));
    writeEntriesTogether(root, entries);
    const pairs = Array.from({ length: PAIRS }, (_, i) => ({
      memory_a_id: entries[2 * i].id,
      memory_b_id: entries[2 * i + 1].id,
      reason: 'test',
      score: 0.9,
    }));
    replaceDetectedConflicts(root, pairs);
    const { statements } = recordStatements(() => replaceDetectedConflicts(root, []));
    expect(countMatching(statements, /^UPDATE memory_conflicts SET status = 'resolved'/)).toBe(2);
    const db = openHippoDb(root);
    try {
      // SAFETY: an aggregate with no GROUP BY always answers one row.
      const open = db.prepare(`SELECT COUNT(*) AS n FROM memory_conflicts WHERE status = 'open'`).get() as {
        n: number;
      };
      expect(open.n).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  }, 60_000);
});
