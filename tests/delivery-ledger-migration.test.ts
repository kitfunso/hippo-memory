/**
 * Schema v50: the per-turn delivery ledger tables (src/recall-trace.ts writes them).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getSchemaVersion, getCurrentSchemaVersion, type DatabaseSyncLike } from '../src/db.js';

const EVENT_COLUMNS = [
  'id', 'ts', 'ledger_version', 'tenant_id', 'runtime', 'event_type', 'surface', 'store_hash', 'write_store',
  'project_hash', 'session_id', 'session_state', 'host_turn_id', 'turn_seq', 'duplicate_of', 'prompt_hash',
  'prompt_length', 'query_hash', 'recall_trace_id', 'block_state', 'prompt_recall', 'considered_count',
  'filtered_count', 'selected_count', 'emitted_count', 'rejected_count', 'rejected_unlisted', 'sections_shown',
  'sections_dropped', 'budget_tokens', 'selected_tokens', 'injected_tokens', 'static_hash', 'recall_hash',
  'emitted_hash', 'elapsed_ms',
];
const CANDIDATE_COLUMNS = [
  'event_id', 'tenant_id', 'memory_id', 'source_store', 'pool', 'stage', 'outcome', 'reason', 'cand_rank', 'score', 'tokens',
];

function names(db: DatabaseSyncLike, sql: string, ...params: string[]): string[] {
  // SAFETY: every query here selects one `name` TEXT column.
  return (db.prepare(sql).all(...params) as Array<{ name: string }>).map((r) => r.name);
}

function count(db: DatabaseSyncLike, table: string): number {
  // SAFETY: a single COUNT(*) aggregate aliased `c`.
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function meta(db: DatabaseSyncLike, key: string): string | undefined {
  // SAFETY: the meta table's value column is TEXT; one row by primary key.
  return (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined)?.value;
}

function insertEvent(db: DatabaseSyncLike, sessionId: string | null, turnSeq: number | null): number {
  return Number(db.prepare(
    `INSERT INTO delivery_events (ts, ledger_version, runtime, event_type, surface, store_hash, write_store, session_id,
       session_state, turn_seq, block_state)
     VALUES (?, 1, 'claude-code', 'prompt-submit', 'hook', 'abcdef0123456789', 'local', ?, 'payload', ?, 'sent')`,
  ).run(new Date().toISOString(), sessionId, turnSeq).lastInsertRowid);
}

function withStore(fn: (db: DatabaseSyncLike, home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'hippo-delivery-mig-'));
  const db = openHippoDb(home);
  try {
    fn(db, home);
  } finally {
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  }
}

describe('delivery ledger schema v50', () => {
  it('a fresh store lands at v50 with both tables and their columns', () => {
    withStore((db) => {
      expect(getSchemaVersion(db)).toBe(50);
      expect(getCurrentSchemaVersion()).toBe(50);
      const tables = names(db, `SELECT name FROM sqlite_master WHERE type='table'`);
      expect(tables).toContain('delivery_events');
      expect(tables).toContain('delivery_candidates');
      expect(names(db, `SELECT name FROM pragma_table_info('delivery_events')`)).toEqual(EVENT_COLUMNS);
      expect(names(db, `SELECT name FROM pragma_table_info('delivery_candidates')`)).toEqual(CANDIDATE_COLUMNS);
    });
  });

  it('has two plain indexes and one partial unique index on events, and none on candidates', () => {
    withStore((db) => {
      const idx = names(db, `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`, 'delivery_events');
      expect(idx).toEqual(['idx_delivery_events_session', 'idx_delivery_events_ts', 'idx_delivery_events_turn']);
      // SAFETY: one TEXT column `sql`.
      const turn = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_delivery_events_turn'`).get() as { sql: string };
      expect(turn.sql).toMatch(/UNIQUE/);
      expect(turn.sql).toMatch(/WHERE turn_seq IS NOT NULL/);
      expect(names(db, `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL`, 'delivery_candidates')).toEqual([]);
    });
  });

  it('the partial unique index rejects a repeated turn_seq but allows many NULLs', () => {
    withStore((db) => {
      insertEvent(db, 's1', 1);
      expect(() => insertEvent(db, 's1', 1)).toThrow(/UNIQUE|constraint/i);
      insertEvent(db, 's1', null);
      insertEvent(db, 's1', null);
      insertEvent(db, 's2', 1);
      expect(count(db, 'delivery_events')).toBe(4);
    });
  });

  it('candidate rows cascade with their event and carry no FK to memories', () => {
    withStore((db) => {
      const id = insertEvent(db, 's1', 1);
      db.prepare(
        `INSERT INTO delivery_candidates (event_id, memory_id, source_store, pool, stage, outcome, reason)
         VALUES (?, 'never-existed', 'local', 'pin', 'budget', 'rejected', 'budget')`,
      ).run(id);
      expect(count(db, 'delivery_candidates')).toBe(1);
      db.prepare(`DELETE FROM delivery_events WHERE id = ?`).run(id);
      expect(count(db, 'delivery_candidates')).toBe(0);
    });
  });

  it('a v49 store re-migrates to v50 and min_compatible_binary is unchanged', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-delivery-mig-'));
    let db = openHippoDb(home);
    const minBefore = meta(db, 'min_compatible_binary');
    try {
      db.exec('DROP TABLE IF EXISTS delivery_candidates');
      db.exec('DROP TABLE IF EXISTS delivery_events');
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '49')`).run();
    } finally {
      closeHippoDb(db);
    }
    db = openHippoDb(home);
    try {
      expect(meta(db, 'schema_version')).toBe('50');
      const tables = names(db, `SELECT name FROM sqlite_master WHERE type='table'`);
      expect(tables).toContain('delivery_events');
      expect(tables).toContain('delivery_candidates');
      expect(meta(db, 'min_compatible_binary')).toBe(minBefore);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
