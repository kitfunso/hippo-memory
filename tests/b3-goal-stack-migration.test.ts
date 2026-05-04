import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getSchemaVersion, getCurrentSchemaVersion } from '../src/db.js';

describe('B3 schema migration v18', () => {
  it('migrates to schema version 20', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      expect(getSchemaVersion(db)).toBe(24);
      expect(getCurrentSchemaVersion()).toBe(24);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates goal_stack with all required columns', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      const cols = db.prepare(`PRAGMA table_info(goal_stack)`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      for (const required of [
        'id', 'session_id', 'tenant_id', 'goal_name', 'level', 'parent_goal_id',
        'status', 'success_condition', 'retrieval_policy_id',
        'created_at', 'completed_at', 'outcome_score',
      ]) {
        expect(names.has(required), `goal_stack.${required} missing`).toBe(true);
      }
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('enforces status CHECK', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      const insert = () => db.prepare(
        `INSERT INTO goal_stack (id, session_id, tenant_id, goal_name, level, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('g1', 's1', 'default', 'test', 0, 'bogus_status', new Date().toISOString());
      expect(insert).toThrow(/CHECK|constraint/i);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('enforces level CHECK 0..2', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      const insert = () => db.prepare(
        `INSERT INTO goal_stack (id, session_id, tenant_id, goal_name, level, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('g1', 's1', 'default', 'test', 5, 'active', new Date().toISOString());
      expect(insert).toThrow(/CHECK|constraint/i);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('enforces outcome_score CHECK 0..1', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      const insert = () => db.prepare(
        `INSERT INTO goal_stack (id, session_id, tenant_id, goal_name, level, status, created_at, outcome_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('g1', 's1', 'default', 'test', 0, 'completed', new Date().toISOString(), 1.5);
      expect(insert).toThrow(/CHECK|constraint/i);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates retrieval_policy + goal_recall_log with FKs and indexes', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      const policyCols = db.prepare(`PRAGMA table_info(retrieval_policy)`).all() as Array<{ name: string }>;
      const policyNames = new Set(policyCols.map((c) => c.name));
      for (const c of ['id', 'goal_id', 'policy_type', 'weight_schema_fit', 'weight_recency', 'weight_outcome', 'error_priority']) {
        expect(policyNames.has(c), `retrieval_policy.${c} missing`).toBe(true);
      }
      const logCols = db.prepare(`PRAGMA table_info(goal_recall_log)`).all() as Array<{ name: string }>;
      const logNames = new Set(logCols.map((c) => c.name));
      for (const c of ['id', 'goal_id', 'memory_id', 'tenant_id', 'session_id', 'recalled_at', 'score']) {
        expect(logNames.has(c), `goal_recall_log.${c} missing`).toBe(true);
      }
      const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>;
      const idxNames = new Set(idx.map((i) => i.name));
      expect(idxNames.has('idx_goal_stack_tenant_session_status')).toBe(true);
      expect(idxNames.has('idx_retrieval_policy_goal')).toBe(true);
      expect(idxNames.has('idx_goal_recall_log_goal')).toBe(true);
      expect(idxNames.has('uniq_goal_recall_log_memory_goal')).toBe(true);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('FKs cascade: deleting a goal deletes its policy and recall log rows', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      db.prepare(`
        INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind)
        VALUES ('m1','2026-04-29','2026-04-29',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','distilled')
      `).run();
      db.prepare(`INSERT INTO goal_stack (id, session_id, tenant_id, goal_name, level, status, created_at) VALUES ('g1','s1','default','t',0,'active',?)`).run(new Date().toISOString());
      db.prepare(`INSERT INTO retrieval_policy (id, goal_id, policy_type) VALUES ('rp1','g1','error-prioritized')`).run();
      db.prepare(`INSERT INTO goal_recall_log (goal_id, memory_id, tenant_id, session_id, recalled_at, score) VALUES ('g1','m1','default','s1',?,1.0)`).run(new Date().toISOString());

      db.prepare(`DELETE FROM goal_stack WHERE id = 'g1'`).run();

      expect((db.prepare(`SELECT COUNT(*) AS c FROM retrieval_policy`).get() as { c: number }).c).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS c FROM goal_recall_log`).get() as { c: number }).c).toBe(0);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
