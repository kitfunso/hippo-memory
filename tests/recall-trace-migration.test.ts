/**
 * LC1 schema migration v40 (docs/plans/2026-08-02-lc1-recall-trace-persistence.md).
 * Mirrors tests/b3-goal-stack-migration.test.ts conventions.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getSchemaVersion, getCurrentSchemaVersion, type DatabaseSyncLike } from '../src/db.js';

function tableNames(db: DatabaseSyncLike): string[] {
  // SAFETY: the query selects only the `name` column from sqlite_master, so every
  // row is shaped { name: string }.
  return (db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as Array<{ name: string }>)
    .map((r) => r.name);
}

function getMeta(db: DatabaseSyncLike, key: string): string | undefined {
  // SAFETY: the meta table's value column is TEXT (nullable by absence of a row);
  // this query selects only that column for a single row by primary key.
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined;
  return row?.value;
}

function setMeta(db: DatabaseSyncLike, key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value);
}

describe('LC1 schema migration v40', () => {
  it('a fresh store lands at v40 with all three tables', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-lc1-mig-'));
    const db = openHippoDb(home);
    try {
      expect(getSchemaVersion(db)).toBe(41);
      expect(getCurrentSchemaVersion()).toBe(41);
      const tables = tableNames(db);
      expect(tables).toContain('recall_traces');
      expect(tables).toContain('recall_trace_results');
      expect(tables).toContain('recall_trace_outcomes');
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('recall_traces has the expected columns + CHECK on pipeline', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-lc1-mig-'));
    const db = openHippoDb(home);
    try {
      // SAFETY: PRAGMA table_info always returns rows with a `name` text column
      // per SQLite's fixed pragma schema.
      const cols = (db.prepare(`PRAGMA table_info(recall_traces)`).all() as Array<{ name: string }>).map((c) => c.name);
      for (const c of ['id', 'ts', 'tenant_id', 'session_id', 'pipeline', 'query_hash', 'query_length', 'result_count', 'explain_mode']) {
        expect(cols, `recall_traces.${c} missing`).toContain(c);
      }
      const insert = () => db.prepare(
        `INSERT INTO recall_traces (ts, tenant_id, pipeline, query_hash, query_length, result_count) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(new Date().toISOString(), 'default', 'bogus_pipeline', 'abc123', 5, 0);
      expect(insert).toThrow(/CHECK|constraint/i);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('recall_trace_results has NO FK on memory_id (traces outlive forgotten memories)', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-lc1-mig-'));
    const db = openHippoDb(home);
    try {
      const traceId = Number(
        db.prepare(
          `INSERT INTO recall_traces (ts, tenant_id, pipeline, query_hash, query_length, result_count) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(new Date().toISOString(), 'default', 'api', 'abc123', 5, 1).lastInsertRowid,
      );
      // memory_id references a memory that never existed — must succeed (no FK).
      expect(() => {
        db.prepare(
          `INSERT INTO recall_trace_results (trace_id, tenant_id, memory_id, result_rank, score) VALUES (?, ?, ?, ?, ?)`,
        ).run(traceId, 'default', 'never-existed-mem-id', 1, 0.9);
      }).not.toThrow();
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('recall_trace_results is WITHOUT ROWID with composite-PK uniqueness on (trace_id, result_rank)', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-lc1-mig-'));
    const db = openHippoDb(home);
    try {
      const traceId = Number(
        db.prepare(
          `INSERT INTO recall_traces (ts, tenant_id, pipeline, query_hash, query_length, result_count) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(new Date().toISOString(), 'default', 'api', 'abc123', 5, 1).lastInsertRowid,
      );
      db.prepare(
        `INSERT INTO recall_trace_results (trace_id, tenant_id, memory_id, result_rank, score) VALUES (?, ?, ?, ?, ?)`,
      ).run(traceId, 'default', 'mem-a', 1, 0.9);
      expect(() => {
        db.prepare(
          `INSERT INTO recall_trace_results (trace_id, tenant_id, memory_id, result_rank, score) VALUES (?, ?, ?, ?, ?)`,
        ).run(traceId, 'default', 'mem-b', 1, 0.5);
      }).toThrow(/UNIQUE|constraint/i);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('recall_traces -> recall_trace_results / recall_trace_outcomes CASCADE on delete', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-lc1-mig-'));
    const db = openHippoDb(home);
    try {
      const traceId = Number(
        db.prepare(
          `INSERT INTO recall_traces (ts, tenant_id, pipeline, query_hash, query_length, result_count) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(new Date().toISOString(), 'default', 'api', 'abc123', 5, 1).lastInsertRowid,
      );
      db.prepare(
        `INSERT INTO recall_trace_results (trace_id, tenant_id, memory_id, result_rank, score) VALUES (?, ?, ?, ?, ?)`,
      ).run(traceId, 'default', 'mem-a', 1, 0.9);
      db.prepare(
        `INSERT INTO recall_trace_outcomes (trace_id, ts, tenant_id, outcome, memory_ids_json) VALUES (?, ?, ?, ?, ?)`,
      ).run(traceId, new Date().toISOString(), 'default', 'positive', '["mem-a"]');

      db.prepare(`DELETE FROM recall_traces WHERE id = ?`).run(traceId);

      // SAFETY: this query selects a single `SELECT COUNT(*) AS c` aggregate, so the
      // driver always returns one row shaped { c: number }.
      expect((db.prepare(`SELECT COUNT(*) AS c FROM recall_trace_results`).get() as { c: number }).c).toBe(0);
      // SAFETY: this query selects a single `SELECT COUNT(*) AS c` aggregate, so the
      // driver always returns one row shaped { c: number }.
      expect((db.prepare(`SELECT COUNT(*) AS c FROM recall_trace_outcomes`).get() as { c: number }).c).toBe(0);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a v39 store upgrades to v40 cleanly without data loss', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-lc1-mig-'));
    // Open once to reach v40, insert a trace row, then roll schema_version
    // back to 39 and drop the three new tables to simulate a pre-v40 store.
    let db = openHippoDb(home);
    closeHippoDb(db);
    db = openHippoDb(home);
    try {
      db.exec('DROP TABLE IF EXISTS recall_trace_outcomes');
      db.exec('DROP TABLE IF EXISTS recall_trace_results');
      db.exec('DROP TABLE IF EXISTS recall_traces');
      setMeta(db, 'schema_version', '39');
    } finally {
      closeHippoDb(db);
    }

    // Re-open triggers runMigrations, which should re-run v40.
    db = openHippoDb(home);
    try {
      expect(getMeta(db, 'schema_version')).toBe('41');
      const tables = tableNames(db);
      expect(tables).toContain('recall_traces');
      expect(tables).toContain('recall_trace_results');
      expect(tables).toContain('recall_trace_outcomes');
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('last_trace_id meta key defaults to empty string on a fresh store', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-lc1-mig-'));
    const db = openHippoDb(home);
    try {
      expect(getMeta(db, 'last_trace_id')).toBe('');
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
