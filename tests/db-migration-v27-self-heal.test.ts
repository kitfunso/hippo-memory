/**
 * v1.12.7 (B6) regression test for migration v27 self-heal.
 *
 * Surfaced 2026-05-24 on Keith's ~/.hippo/hippo.db: schema_version recorded
 * as 25 but api_keys and audit_log tables were missing. Root cause unknown
 * (BEGIN/COMMIT wrapping has been in place since the first SQLite commit),
 * but the symptom is real and reproducible. Migration v27 re-asserts the
 * v16 schema with CREATE IF NOT EXISTS — fixes affected DBs on next open,
 * zero-cost for DBs that already have the tables.
 *
 * Also covers v26 defensive guard: when api_keys is missing, v26's ALTER
 * must no-op rather than crash and block all later migrations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';

function tableNames(db: DatabaseSyncLike): string[] {
  return (db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as Array<{ name: string }>)
    .map((r) => r.name);
}

function getMeta(db: DatabaseSyncLike, key: string): string | undefined {
  const row = db
    .prepare(`SELECT value FROM meta WHERE key = ?`)
    .get(key) as { value?: string } | undefined;
  return row?.value;
}

function setMeta(db: DatabaseSyncLike, key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value);
}

describe('migration v27 self-heal — partial-applied v16 state', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-v27-heal-'));
    initStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function simulatePartialV16State(): void {
    // Get the DB to a state matching Keith's ~/.hippo/hippo.db on 2026-05-24:
    // - schema_version = 25 (later migrations applied)
    // - api_keys + audit_log tables missing (v16 partial-apply)
    const db = openHippoDb(root);
    try {
      db.exec('DROP TABLE IF EXISTS api_keys');
      db.exec('DROP TABLE IF EXISTS audit_log');
      // Roll schema_version back to 25 so the next open re-runs v26 and v27.
      setMeta(db, 'schema_version', '25');
    } finally {
      closeHippoDb(db);
    }
  }

  it('re-opening a DB in Keith\'s partial-v16 state heals it to v27', () => {
    simulatePartialV16State();

    // Re-open triggers runMigrations which should run v26 (no-op on missing
    // api_keys per the defensive guard) then v27 (creates both tables).
    const db = openHippoDb(root);
    try {
      const tables = tableNames(db);
      expect(tables).toContain('api_keys');
      expect(tables).toContain('audit_log');
      expect(getMeta(db, 'schema_version')).toBe('38');
    } finally {
      closeHippoDb(db);
    }
  });

  it('api_keys created by v27 has the role column already (no extra ALTER needed)', () => {
    simulatePartialV16State();

    const db = openHippoDb(root);
    try {
      const cols = (db
        .prepare(`PRAGMA table_info(api_keys)`)
        .all() as Array<{ name: string }>)
        .map((r) => r.name);
      expect(cols).toContain('role');
      expect(cols).toContain('key_id');
      expect(cols).toContain('key_hash');
      expect(cols).toContain('tenant_id');
    } finally {
      closeHippoDb(db);
    }
  });

  it('audit_log created by v27 has the expected v16 shape', () => {
    simulatePartialV16State();

    const db = openHippoDb(root);
    try {
      const cols = (db
        .prepare(`PRAGMA table_info(audit_log)`)
        .all() as Array<{ name: string }>)
        .map((r) => r.name);
      expect(cols).toEqual(
        expect.arrayContaining(['id', 'ts', 'tenant_id', 'actor', 'op', 'target_id', 'metadata_json']),
      );
    } finally {
      closeHippoDb(db);
    }
  });

  it('v27 is a no-op on a healthy DB (CREATE IF NOT EXISTS)', () => {
    // Open + close once to apply all migrations to current head.
    closeHippoDb(openHippoDb(root));

    // Roll schema_version back to 26 to force v27 to re-run on a DB that
    // already has the tables. v27 must not error.
    const db1 = openHippoDb(root);
    try {
      setMeta(db1, 'schema_version', '26');
    } finally {
      closeHippoDb(db1);
    }

    // Re-open re-runs v27; should be a no-op + bump schema_version to 27.
    const db2 = openHippoDb(root);
    try {
      const tables = tableNames(db2);
      expect(tables).toContain('api_keys');
      expect(tables).toContain('audit_log');
      expect(getMeta(db2, 'schema_version')).toBe('38');
    } finally {
      closeHippoDb(db2);
    }
  });

  it('v26 ALTER no-ops when api_keys table is missing (defensive guard)', () => {
    // This test specifically locks the v26 fix: tableExists guard added
    // alongside the existing tableHasColumn guard. Without it, v26 would
    // crash on the partial-apply state before v27 could heal.
    simulatePartialV16State();

    // Should not throw — v26 sees api_keys missing and no-ops.
    expect(() => {
      const db = openHippoDb(root);
      closeHippoDb(db);
    }).not.toThrow();
  });
});
