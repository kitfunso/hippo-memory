// Pins behaviour the existing suites leave loose, ahead of the Q10 long-function split:
// the brief digest's budget cut and every retrieval-policy branch of the goal-stack boost.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { assembleBriefFromReceipts, MAX_BRIEF_SUMMARY_LEN } from '../src/project-briefs.js';
import { computeGoalStackBoost, pushGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { Layer, type MemoryEntry } from '../src/memory.js';
import type { RerankStep } from '../src/search/types.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { makeRoot } from './_helpers/make-root.js';

describe('assembleBriefFromReceipts budget cut (Q10 characterization)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('q10-brief'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('keeps receipt lines under the cap and reports the omitted remainder', () => {
    for (let i = 0; i < 50; i++) {
      writeEntry(root, createMemory(`${String(i).padStart(2, '0')}${'x'.repeat(298)}`, { tags: ['path:big'], layer: Layer.Episodic }));
    }
    const { markdown, receiptCount } = assembleBriefFromReceipts(root, 'default', 'big');
    expect(receiptCount).toBe(50);
    expect(markdown.length).toBeLessThanOrEqual(MAX_BRIEF_SUMMARY_LEN);
    const kept = markdown.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(kept).toMatchInlineSnapshot(`34`);
    expect(markdown).toContain(`_Auto-assembled from ${kept} of 50 receipt(s)._`);
    expect(markdown).toContain(`_... ${50 - kept} more receipt(s) omitted (summary cap)._`);
    expect(markdown.length).toMatchInlineSnapshot(`7716`);
  });
});

describe('computeGoalStackBoost policy branches (Q10 characterization)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('q10-goals'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function stored(content: string, tags: string[], schemaFit?: number): MemoryEntry {
    const e = createMemory(content, { tags, layer: Layer.Episodic });
    if (schemaFit !== undefined) e.schema_fit = schemaFit;
    writeEntry(root, e);
    return e;
  }

  it('composes every policy type, caps at 3x, logs only local top-k rows', () => {
    const tenantId = 'default';
    const sessionId = 's-a';
    pushGoal(root, { sessionId, tenantId, goalName: 'g-err', policy: { policyType: 'error-prioritized', errorPriority: 1.2 } });
    pushGoal(root, { sessionId, tenantId, goalName: 'g-fit', policy: { policyType: 'schema-fit-biased', weightSchemaFit: 1.5 } });
    pushGoal(root, { sessionId, tenantId, goalName: 'g-rec', policy: { policyType: 'recency-first', weightRecency: 1.1 } });
    pushGoal(root, { sessionId: 's-b', tenantId, goalName: 'g-hyb', policy: { policyType: 'hybrid', weightOutcome: 1.3 } });

    const errRow = stored('err row', ['g-err', 'error']);
    const fitRow = stored('fit row', ['g-fit'], 0.8);
    const recRow = stored('rec row', ['g-rec']);
    const twoRow = stored('two row', ['g-err', 'g-rec']);
    const plain = stored('plain row', ['other']);
    const capped = stored('capped row', ['g-err', 'g-fit', 'error']);
    const global = createMemory('global row', { tags: ['g-fit'], layer: Layer.Episodic });
    const rows = [plain, errRow, fitRow, recRow, twoRow, global, capped].map((entry, i) => ({ entry, score: 1 + i / 10 }));

    const trace = new Map<string, RerankStep>();
    const db = openHippoDb(root);
    try {
      const a = computeGoalStackBoost(db, rows, { sessionId, tenantId, limit: 4, trace });
      expect(a.results.map((r) => [r.entry.content, Number(r.score.toFixed(6))])).toMatchInlineSnapshot(`
        [
          [
            "capped row",
            4.8,
          ],
          [
            "two row",
            3.85,
          ],
          [
            "global row",
            3.75,
          ],
          [
            "fit row",
            3.36,
          ],
          [
            "rec row",
            2.86,
          ],
          [
            "err row",
            2.64,
          ],
          [
            "plain row",
            1,
          ],
        ]
      `);
      expect(a.log.map((l) => [l.memoryId === errRow.id ? 'err' : l.memoryId === fitRow.id ? 'fit' : l.memoryId === recRow.id ? 'rec' : l.memoryId === twoRow.id ? 'two' : l.memoryId === capped.id ? 'capped' : l.memoryId, l.score])).toMatchInlineSnapshot(`
        [
          [
            "capped",
            4.800000000000001,
          ],
          [
            "capped",
            4.800000000000001,
          ],
          [
            "two",
            3.8499999999999996,
          ],
          [
            "two",
            3.8499999999999996,
          ],
          [
            "fit",
            3.36,
          ],
        ]
      `);
      expect([...trace.values()].map((t) => [t.note, Number(t.multiplier?.toFixed(6))])).toMatchInlineSnapshot(`
        [
          [
            "g-err",
            2.4,
          ],
          [
            "g-fit",
            2.8,
          ],
          [
            "g-rec",
            2.2,
          ],
          [
            "g-err, g-rec",
            2.75,
          ],
          [
            "g-fit",
            2.5,
          ],
          [
            "g-err, g-fit",
            3,
          ],
        ]
      `);

      const b = computeGoalStackBoost(db, [{ entry: stored('hyb row', ['g-hyb']), score: 1 }], { sessionId: 's-b', tenantId, limit: 5 });
      expect(b.results[0]!.score).toBeCloseTo(2.6, 10);
      expect(b.log).toHaveLength(1);

      const none = computeGoalStackBoost(db, rows, { sessionId: 's-none', tenantId, limit: 5 });
      expect(none.results).toBe(rows);
      expect(none.log).toEqual([]);
    } finally {
      closeHippoDb(db);
    }
  });
});
