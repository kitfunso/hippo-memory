/**
 * v1.7.4 -- applyGoalStackBoost helper, lifted from src/cli.ts:988-1140 in
 * v0.38.0's CLI-only B3 dlPFC implementation. Pinned here at the helper
 * boundary so api.recall + MCP + HTTP integrations can build on a
 * known-correct primitive.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { applyGoalStackBoost, pushGoal } from '../src/goals.js';
import { remember } from '../src/api.js';
import { Layer, type MemoryEntry } from '../src/memory.js';

interface ScoredRow { entry: MemoryEntry; score: number; }

describe('applyGoalStackBoost (v1.7.4)', () => {
  let hippoRoot: string;
  const tenantId = 'default';
  const sessionId = 'sess-1.7.4';

  beforeEach(async () => {
    hippoRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hippo-1.7.4-helper-'));
    initStore(hippoRoot);
  });

  // Fully-populated MemoryEntry fixture: applyGoalStackBoost only reads
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
      const out = applyGoalStackBoost(db, rows, { sessionId, tenantId, limit: 10 });
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
      applyGoalStackBoost(db, rows, { sessionId, tenantId, limit: 10 });
      applyGoalStackBoost(db, rows, { sessionId, tenantId, limit: 10 });
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
      applyGoalStackBoost(db, rows, { sessionId, tenantId, limit: 10 });
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
      const out = applyGoalStackBoost(db, rows, { sessionId, tenantId: 'B', limit: 10 });
      // No active goals in tenant B -> no boost, no reorder -> m2 stays first.
      expect(out[0]?.entry.id).toBe('m2');
      // Sanity: m1 would have ranked first under tenant A (0.5 * 2.0x = 1.0 > 0.6).
      const outA = applyGoalStackBoost(db, rows, { sessionId, tenantId: 'A', limit: 10 });
      expect(outA[0]?.entry.id).toBe('m1');
    } finally {
      closeHippoDb(db);
    }
  });
});
