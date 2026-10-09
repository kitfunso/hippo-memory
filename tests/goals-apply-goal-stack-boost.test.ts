/**
 * v1.7.4 -- goal-stack boost and log write, lifted from src/cli.ts:988-1140 in
 * v0.38.0's CLI-only B3 dlPFC implementation. Pinned here at the helper
 * boundary so api.recall + MCP + HTTP integrations can build on a
 * known-correct primitive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import type { RerankStep } from '../src/core/search-types.js';
import { createMemory as createDefaultMemory } from './_helpers/default-half-life-memory.js';
import { makeRoot } from './_helpers/make-root.js';
import { initStore } from '../src/store/open.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { computeGoalStackBoost, pushGoal, writeGoalRecallLog, type GoalStackBoostOpts } from '../src/goals.js';
import { remember } from '../src/api.js';
import { Layer, type MemoryEntry } from '../src/memory.js';

interface ScoredRow { entry: MemoryEntry; score: number; }

/** Boosts, then writes the log rows the boost earned on the same handle. */
function boostAndLog(db: DatabaseSyncLike, rows: ScoredRow[], opts: GoalStackBoostOpts): ScoredRow[] {
  const boost = computeGoalStackBoost(db, rows, opts);
  writeGoalRecallLog(db, boost.log);
  return boost.results;
}

describe('computeGoalStackBoost plus writeGoalRecallLog (v1.7.4)', () => {
  let hippoRoot: string;
  const tenantId = 'default';
  const sessionId = 'sess-1.7.4';

  beforeEach(async () => {
    hippoRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hippo-1.7.4-helper-'));
    initStore(hippoRoot);
  });

  // Fully-populated MemoryEntry fixture: the boost only reads
  // entry.id and entry.tags, but the ScoredRow contract requires the whole
  // shape, so every required field gets a neutral default here rather than
  // asserting past the type checker.
  function makeMemoryEntry(id: string, tags: string[], strength: number): MemoryEntry {
    const now = new Date().toISOString();
    return {
      id,
      created: now,
      last_retrieved: now,
      retrieval_count: 0,
      strength,
      half_life_days: 90,
      layer: Layer.Episodic,
      tags,
      emotional_valence: 'neutral',
      schema_fit: 0.5,
      source: 'test',
      outcome_score: null,
      outcome_positive: 0,
      outcome_negative: 0,
      conflicts_with: [],
      pinned: false,
      confidence: 'observed',
      content: `c-${id}`,
      parents: [],
      starred: false,
      trace_outcome: null,
      source_session_id: null,
      valid_from: now,
      superseded_by: null,
      extracted_from: null,
      dag_level: 0,
      dag_parent_id: null,
      kind: 'raw',
      scope: null,
      owner: null,
      artifact_ref: null,
      tenantId: 'default',
    };
  }

  function makeRow(id: string, tags: string[], score: number): ScoredRow {
    return { entry: makeMemoryEntry(id, tags, 0.5), score };
  }

  it('boosts rows whose tags match an active goal name', () => {
    pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'fix-auth' });
    const rows = [makeRow('m1', ['fix-auth'], 0.5), makeRow('m2', ['ui'], 0.6)];
    const db = openHippoDb(hippoRoot);
    try {
      const out = boostAndLog(db, rows, { sessionId, tenantId, limit: 10 });
      // Boosted (m1: 0.5 * 2.0x = 1.0) ranks above unboosted (m2: 0.6).
      expect(out[0]?.entry.id).toBe('m1');
    } finally {
      closeHippoDb(db);
    }
  });

  it('writes one goal_recall_log row per (boosted_memory, goal) -- INSERT OR IGNORE on repeat', async () => {
    const goal = pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'fix-auth' });
    // Memory must exist locally so the FK-safe INSERT path fires.
    const m = remember({ hippoRoot, tenantId, actor: { subject: 'test', role: 'admin' } }, {
      content: 'fix auth bug',
      tags: ['fix-auth'],
    });
    const rows = [makeRow(m.id, ['fix-auth'], 0.5)];
    const db = openHippoDb(hippoRoot);
    try {
      boostAndLog(db, rows, { sessionId, tenantId, limit: 10 });
      boostAndLog(db, rows, { sessionId, tenantId, limit: 10 });
      // SAFETY: `SELECT COUNT(*) AS c` always returns exactly one row shaped { c: number }.
      const count = (db.prepare(
        `SELECT COUNT(*) AS c FROM goal_recall_log WHERE goal_id = ? AND memory_id = ?`,
      ).get(goal.id, m.id) as { c: number }).c;
      expect(count).toBe(1); // UNIQUE(memory_id, goal_id) idempotency
    } finally {
      closeHippoDb(db);
    }
  });

  it('does NOT write goal_recall_log rows for memories absent from the local memories table (FK safety)', () => {
    pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'fix-auth' });
    // m-global was never written via remember() -- simulates global-only id
    const rows = [makeRow('m-global', ['fix-auth'], 0.5)];
    const db = openHippoDb(hippoRoot);
    try {
      boostAndLog(db, rows, { sessionId, tenantId, limit: 10 });
      // SAFETY: `SELECT COUNT(*) AS c` always returns exactly one row shaped { c: number }.
      const count = (db.prepare(
        `SELECT COUNT(*) AS c FROM goal_recall_log WHERE memory_id = 'm-global'`,
      ).get() as { c: number }).c;
      expect(count).toBe(0); // global-only id filtered before INSERT
    } finally {
      closeHippoDb(db);
    }
  });

  it('respects tenant isolation -- same sessionId in tenant B does NOT load tenant A goals', () => {
    pushGoal(hippoRoot, { sessionId, tenantId: 'A', goalName: 'fix-auth' });
    // Pre-sorted as the BM25 caller would: m2 (0.6) ahead of m1 (0.5).
    const rows = [makeRow('m2', ['ui'], 0.6), makeRow('m1', ['fix-auth'], 0.5)];
    const db = openHippoDb(hippoRoot);
    try {
      const out = boostAndLog(db, rows, { sessionId, tenantId: 'B', limit: 10 });
      // No active goals in tenant B -> no boost, no reorder -> m2 stays first.
      expect(out[0]?.entry.id).toBe('m2');
      // Sanity: m1 would have ranked first under tenant A (0.5 * 2.0x = 1.0 > 0.6).
      const outA = boostAndLog(db, rows, { sessionId, tenantId: 'A', limit: 10 });
      expect(outA[0]?.entry.id).toBe('m1');
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('computeGoalStackBoost policy branches', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('goal-policy-branches'); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function stored(content: string, tags: string[], schemaFit?: number): MemoryEntry {
    const e = createDefaultMemory(content, { tags, layer: Layer.Episodic });
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
    const global = createDefaultMemory('global row', { tags: ['g-fit'], layer: Layer.Episodic });
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
