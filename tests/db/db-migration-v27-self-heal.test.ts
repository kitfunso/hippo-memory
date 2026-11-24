import { describe, it, expect, beforeEach } from 'vitest';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { LATEST_SCHEMA_VERSION_STR } from '../_helpers/schema-version.js';
import { makeRoot } from '../_helpers/make-root.js';

function tableNames(db: DatabaseSyncLike): string[] {
  // SAFETY: DatabaseSyncLike#all() returns `unknown[]`; the row shape is guaranteed
  // by the `SELECT name FROM sqlite_master` projection above.
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function getMeta(db: DatabaseSyncLike, key: string): string | undefined {
  // SAFETY: DatabaseSyncLike#get() returns `unknown`; the row shape is guaranteed
  // by the `SELECT value FROM meta` projection above (undefined when no row matches).
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined;
  return row?.value;
}

function setMeta(db: DatabaseSyncLike, key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value);
}

describe('migration v27 self-heal — partial-applied v16 state', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('v27-heal');
  });

  function simulatePartialV16State(): void {
    const db = openHippoDb(root);
    try {
      db.exec('DROP TABLE IF EXISTS api_keys');
      db.exec('DROP TABLE IF EXISTS audit_log');
      setMeta(db, 'schema_version', '25');
    } finally {
      closeHippoDb(db);
    }
  }

  it("re-opening a DB in Keith's partial-v16 state heals it to v27", () => {
    simulatePartialV16State();

    const db = openHippoDb(root);
    try {
      const tables = tableNames(db);
      expect(tables).toContain('api_keys');
      expect(tables).toContain('audit_log');
      expect(getMeta(db, 'schema_version')).toBe(LATEST_SCHEMA_VERSION_STR);
    } finally {
      closeHippoDb(db);
    }
  });

  it('api_keys created by v27 has the role column already (no extra ALTER needed)', () => {
    simulatePartialV16State();

    const db = openHippoDb(root);
    try {
      // SAFETY: DatabaseSyncLike#all() returns `unknown[]`; PRAGMA table_info always
      const cols = (db.prepare(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string }>).map((r) => r.name);
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
      // SAFETY: DatabaseSyncLike#all() returns `unknown[]`; PRAGMA table_info always
      const cols = (db.prepare(`PRAGMA table_info(audit_log)`).all() as Array<{ name: string }>).map((r) => r.name);
      expect(cols).toEqual(
        expect.arrayContaining(['id', 'ts', 'tenant_id', 'actor', 'op', 'target_id', 'metadata_json']),
      );
    } finally {
      closeHippoDb(db);
    }
  });

  it('v27 is a no-op on a healthy DB (CREATE IF NOT EXISTS)', () => {
    closeHippoDb(openHippoDb(root));

    const db1 = openHippoDb(root);
    try {
      setMeta(db1, 'schema_version', '26');
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      const tables = tableNames(db2);
      expect(tables).toContain('api_keys');
      expect(tables).toContain('audit_log');
      expect(getMeta(db2, 'schema_version')).toBe(LATEST_SCHEMA_VERSION_STR);
    } finally {
      closeHippoDb(db2);
    }
  });

  it('v26 ALTER no-ops when api_keys table is missing (defensive guard)', () => {
    simulatePartialV16State();

    const db = openHippoDb(root);
    try {
      expect(tableNames(db)).toEqual(expect.arrayContaining(['api_keys', 'audit_log']));
      expect(getMeta(db, 'schema_version')).toBe(LATEST_SCHEMA_VERSION_STR);
      // SAFETY: PRAGMA table_info rows always carry `name`, the only field read.
      const cols = (db.prepare(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string }>).map((r) => r.name);
      expect(cols).toContain('role');
    } finally {
      closeHippoDb(db);
    }
  });
});
