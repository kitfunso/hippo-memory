// Schema v54 adds nullable owner and project columns, the session binding table and retry ids, and never raises the floor.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb, getSchemaVersion, type DatabaseSyncLike } from '../src/db.js';
import { REQUIRED_SCHEMA_OBJECTS } from '../src/db/continuity.js';
import { tableColumns, tableExists } from '../src/db/tables.js';
import { recordFailure } from '../src/failure-log.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';
import { makeRoot } from './_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from './_helpers/schema-version.js';

const OWNER_TABLES = ['task_snapshots', 'session_handoffs', 'failure_log'] as const;
const OWNER_INDEXES = ['idx_task_snapshots_owner', 'idx_session_handoffs_owner'] as const;
const REQUEST_INDEXES = { compactions: 'idx_compactions_request', failure_log: 'idx_failure_log_request' } as const;

let home: string;

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function meta(db: DatabaseSyncLike, key: string): string | undefined {
  // SAFETY: the meta table's value column is TEXT; one row by primary key.
  return (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined)?.value;
}

function indexSql(db: DatabaseSyncLike, name: string): string | undefined {
  // SAFETY: one TEXT `sql` column.
  return (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name) as { sql?: string } | undefined)?.sql;
}

/** Puts the store back to its v53 shape, keeping every row, with the floor at `floor`. */
function rewindToV53(floor: string): void {
  withDb((db) => {
    for (const idx of [...OWNER_INDEXES, ...Object.values(REQUEST_INDEXES)]) db.exec(`DROP INDEX IF EXISTS ${idx}`);
    for (const t of OWNER_TABLES) for (const c of ['owner_subject', 'origin_project']) db.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    for (const t of Object.keys(REQUEST_INDEXES)) db.exec(`ALTER TABLE ${t} DROP COLUMN request_id`);
    db.exec('DROP TABLE session_owners');
    db.prepare(`UPDATE meta SET value = '53' WHERE key = 'schema_version'`).run();
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'min_compatible_binary'`).run(floor);
    db.exec('PRAGMA user_version = 53');
  });
}

beforeEach(() => {
  home = makeRoot('migration-v54');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('schema v54', () => {
  it('fresh store has both columns on three tables, session_owners and two indexes', () => {
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      for (const t of OWNER_TABLES) expect([...tableColumns(db, t)]).toEqual(expect.arrayContaining(['owner_subject', 'origin_project']));
      expect([...tableColumns(db, 'session_owners')].sort()).toEqual(['created_at', 'owner_subject', 'session_id', 'tenant_id']);
      expect(indexSql(db, 'idx_task_snapshots_owner')).toMatch(/\(tenant_id, owner_subject, origin_project, status, updated_at DESC\)/);
      expect(indexSql(db, 'idx_session_handoffs_owner')).toMatch(/\(tenant_id, owner_subject, origin_project, created_at DESC\)/);
      for (const [t, idx] of Object.entries(REQUEST_INDEXES)) {
        expect(tableColumns(db, t).has('request_id')).toBe(true);
        expect(indexSql(db, idx)).toMatch(/UNIQUE INDEX .*\(tenant_id, request_id\) WHERE request_id IS NOT NULL/);
      }
    });
  });

  it('v53 store upgrades with guarded ALTERs and rows untouched, owners NULL', () => {
    const snap = saveActiveTaskSnapshot(home, 'default', { task: 'ship v54', summary: 'columns', next_step: 'test', session_id: 's1' });
    saveSessionHandoff(home, 'default', { version: 1, sessionId: 's1', summary: 'half done', nextAction: 'finish' });
    withDb((db) => recordFailure(db, { tenantId: 'default', sessionId: 's1', tool: 'Bash', outcome: 'stored', sigHash: 'abc' }));
    rewindToV53('1.24.0');
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      // SAFETY: the SELECT names exactly these four columns.
      const s = db.prepare(`SELECT id, task, owner_subject, origin_project FROM task_snapshots`).all() as Array<Record<string, unknown>>;
      expect(s).toEqual([{ id: snap.id, task: 'ship v54', owner_subject: null, origin_project: null }]);
      // SAFETY: the SELECT names exactly these four columns.
      const h = db.prepare(`SELECT session_id, summary, owner_subject, origin_project FROM session_handoffs`).all() as Array<Record<string, unknown>>;
      expect(h).toEqual([{ session_id: 's1', summary: 'half done', owner_subject: null, origin_project: null }]);
      // SAFETY: the SELECT names exactly these four columns.
      const f = db.prepare(`SELECT sig_hash, owner_subject, origin_project, request_id FROM failure_log`).all() as Array<Record<string, unknown>>;
      expect(f).toEqual([{ sig_hash: 'abc', owner_subject: null, origin_project: null, request_id: null }]);
      expect(tableExists(db, 'session_owners')).toBe(true);
      for (const idx of [...OWNER_INDEXES, ...Object.values(REQUEST_INDEXES)]) expect(indexSql(db, idx)).toBeDefined();
    });
  });

  it('rerun is a no-op', () => {
    const before = withDb((db) => OWNER_TABLES.map((t) => [...tableColumns(db, t)]));
    withDb((db) => {
      db.prepare(`UPDATE meta SET value = '53' WHERE key = 'schema_version'`).run();
      db.exec('PRAGMA user_version = 53');
    });
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(OWNER_TABLES.map((t) => [...tableColumns(db, t)])).toEqual(before);
    });
  });

  it('v54 leaves min_compatible_binary alone', () => {
    rewindToV53('0.0.1');
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(meta(db, 'min_compatible_binary')).toBe('0.0.1');
    });
  });

  it('REQUIRED_SCHEMA_OBJECTS names session_owners and both indexes', () => {
    expect(REQUIRED_SCHEMA_OBJECTS).toEqual(expect.arrayContaining(['session_owners', ...OWNER_INDEXES]));
  });
});
