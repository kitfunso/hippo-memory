// Schema v62 adds four partial indexes for the sleep path; each real read must plan onto its index.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, getSchemaVersion, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { cleanupArchivedMirrors } from '../../src/db/raw-archive-mirror-cleanup.js';
import { conflictResolveAuditsAt } from '../../src/store/sqlite/conflicts.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, DAG_LEVEL } from '../../src/base/memory/memory.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from '../_helpers/schema-version.js';
import { loadAllDirtySummaries, loadAllL2Summaries, writeEntry } from '../_helpers/root-forms.js';

const DIRTY = 'idx_memories_summary_dirty';
const L2 = 'idx_memories_l2_unparented';
const AUDIT = 'idx_audit_log_conflict_resolve';
const MIRROR = 'idx_raw_archive_mirror_pending';
const ALL = [DIRTY, L2, AUDIT, MIRROR];

let home: string;

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function plan(db: DatabaseSyncLike, sql: string): string {
  const binds = Array.from({ length: sql.split('?').length - 1 }, () => 1);
  // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail).join(' | ');
}

function indexNames(db: DatabaseSyncLike): string[] {
  // SAFETY: one `name` TEXT column.
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

function count(db: DatabaseSyncLike, table: string): number {
  // SAFETY: one COUNT column.
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// A partial index holds only the rare rows, so a SCAN of it is the whole win; a temp sort would not be.
function expectIndexNoSort(detail: string, index: string): void {
  expect(detail).toContain(`USING INDEX ${index}`);
  expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY');
}

function failNoSql(): never {
  throw new Error('the read did not prepare the expected statement');
}

function seedMemories(): void {
  for (let i = 0; i < 6; i++) {
    writeEntry(home, createMemory(`row ${i}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
  }
  withDb((db) => {
    db.exec(
      `UPDATE memories SET summary_dirty = 1, dag_level = ${DAG_LEVEL.topic} WHERE id IN (SELECT id FROM memories LIMIT 2)`,
    );
  });
}

function seedLogs(): void {
  withDb((db) => {
    const audit = db.prepare(`INSERT INTO audit_log (ts, actor, op, metadata_json) VALUES (?, 'a', ?, '{}')`);
    for (let i = 0; i < 20; i++) {
      audit.run(`2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, i < 2 ? 'conflict_resolve' : 'remember');
    }
    const raw = db.prepare(
      `INSERT INTO raw_archive (memory_id, archived_at, reason, payload_json, mirror_cleaned_at) VALUES (?, 'now', 'r', '{}', ?)`,
    );
    for (let i = 0; i < 20; i++) raw.run(`m${i}`, i < 2 ? null : 'done');
  });
}

beforeEach(() => {
  home = makeRoot('migration-v62');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('schema v62', () => {
  it('a fresh store has the four indexes', () => {
    withDb((db) => expect(indexNames(db)).toEqual(expect.arrayContaining(ALL)));
  });

  it('reads dirty summaries through the dirty index', () => {
    seedMemories();
    const { statements } = recordStatements(() => loadAllDirtySummaries(home, 5));
    const sql = statements.find((s) => s.includes('summary_dirty = 1')) ?? failNoSql();
    withDb((db) => expectIndexNoSort(plan(db, sql), DIRTY));
  });

  it('reads unparented topic summaries through the L2 index', () => {
    seedMemories();
    const { statements } = recordStatements(() => loadAllL2Summaries(home));
    const sql = statements.find((s) => s.includes('dag_parent_id IS NULL')) ?? failNoSql();
    withDb((db) => expectIndexNoSort(plan(db, sql), L2));
  });

  it('reads conflict audit rows through the audit index', () => {
    seedLogs();
    withDb((db) => {
      const { statements } = recordStatements(() => conflictResolveAuditsAt(db));
      const sql = statements.find((s) => s.includes('FROM audit_log')) ?? failNoSql();
      expect(plan(db, sql)).toContain(`USING INDEX ${AUDIT}`);
    });
  });

  it('reads uncleaned mirrors through the mirror index', () => {
    seedLogs();
    withDb((db) => {
      const { statements } = recordStatements(() => cleanupArchivedMirrors(home, db));
      const sql = statements.find((s) => s.includes('FROM raw_archive')) ?? failNoSql();
      expect(plan(db, sql)).toMatch(new RegExp(`USING (COVERING )?INDEX ${MIRROR}`));
    });
  });

  it('upgrades a v61 store with rows in it and keeps every row', () => {
    seedMemories();
    seedLogs();
    withDb((db) => {
      for (const name of ALL) db.exec(`DROP INDEX ${name}`);
      db.prepare(`UPDATE meta SET value = '61' WHERE key = 'schema_version'`).run();
      db.exec('PRAGMA user_version = 61');
    });
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(indexNames(db)).toEqual(expect.arrayContaining(ALL));
      expect(count(db, 'memories')).toBe(6);
      expect(count(db, 'audit_log')).toBeGreaterThanOrEqual(20);
      expect(count(db, 'raw_archive')).toBe(20);
    });
  });
});
