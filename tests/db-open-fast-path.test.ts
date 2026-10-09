// Opening a current, whole store runs one probe and no DDL; anything stale or missing takes the self-healing slow path.
// Real SQLite stores throughout; the statement spy wraps node:sqlite and passes every call through.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { consolidate } from '../src/consolidate/sleep.js';
import { runDoctor } from '../src/doctor.js';
import { openHippoDb, closeHippoDb, getMeta, setMeta, ftsRowCounts, getCurrentSchemaVersion, type DatabaseSyncLike } from '../src/db.js';
import { REQUIRED_SCHEMA_OBJECTS } from '../src/db/continuity.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; mirrors tests/fts-sync-check-count.test.ts.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: { prototype: { prepare: (sql: string) => object; exec: (sql: string) => void } };
};

const CURRENT = getCurrentSchemaVersion();
const DDL = /\b(CREATE|ALTER|DROP)\s/i;
const ANY_CREATE = /CREATE\s+(?:TEMP\w*\s+)?(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/gi;

let root: string;
let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-open-fast-path-'));
  root = path.join(cwd, '.hippo');
  initStore(root);
  writeEntry(root, createMemory('the quokka deploy key rotates every ninety days', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

/** Every SQL string sent through exec or prepare while `fn` runs. */
function captureStatements(fn: () => void): string[] {
  const statements: string[] = [];
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalExec = DatabaseSync.prototype.exec;
  const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSyncLike, ...args: [string]) {
    statements.push(args[0]);
    return originalPrepare.apply(this, args);
  });
  const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSyncLike, ...args: [string]) {
    statements.push(args[0]);
    return originalExec.apply(this, args);
  });
  try {
    fn();
  } finally {
    prepareSpy.mockRestore();
    execSpy.mockRestore();
  }
  return statements;
}

function openAndClose(): string[] {
  return captureStatements(() => closeHippoDb(openHippoDb(root)));
}

function withDb(fn: (db: DatabaseSyncLike) => void): void {
  const db = openHippoDb(root);
  try {
    fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function userVersion(db: DatabaseSyncLike): number {
  // SAFETY: PRAGMA user_version returns one row with one integer column.
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

function objectExists(db: DatabaseSyncLike, name: string): boolean {
  return db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE name = ?`).get(name) !== undefined;
}

describe('store open fast path', () => {
  it('opens a current store with no DDL and no row counts', () => {
    const statements = openAndClose();

    expect(statements.filter((sql) => DDL.test(sql))).toEqual([]);
    expect(statements.filter((sql) => /COUNT\(\*\)/i.test(sql) && !/sqlite_master|FROM meta/i.test(sql))).toEqual([]);
  });

  it('every CREATE the slow path runs names an object in the required list, and every listed object is created', () => {
    withDb((db) => db.prepare(`DELETE FROM meta WHERE key = 'last_trace_id'`).run());

    const created = new Set(openAndClose().flatMap((sql) => [...sql.matchAll(ANY_CREATE)].map((m) => m[1])));

    expect([...created].filter((name) => !REQUIRED_SCHEMA_OBJECTS.includes(name))).toEqual([]);
    expect(REQUIRED_SCHEMA_OBJECTS.filter((name) => !created.has(name))).toEqual([]);
    expect(REQUIRED_SCHEMA_OBJECTS).toContain('idx_memory_quarantine_status');
  });

  it('applies the last migration when both versions are stale', () => {
    withDb((db) => {
      setMeta(db, 'schema_version', String(CURRENT - 1));
      db.exec(`PRAGMA user_version = ${CURRENT - 1}`);
    });
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    const up = vi.spyOn(last, 'up').mockImplementation(() => undefined);
    try {
      withDb((db) => {
        expect(getMeta(db, 'schema_version')).toBe(String(CURRENT));
        expect(userVersion(db)).toBe(CURRENT);
      });
      expect(up).toHaveBeenCalledTimes(1);
    } finally {
      up.mockRestore();
    }
  });

  it('still migrates when only meta schema_version was rolled back', () => {
    withDb((db) => setMeta(db, 'schema_version', String(CURRENT - 1)));
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    const up = vi.spyOn(last, 'up').mockImplementation(() => undefined);
    try {
      withDb((db) => expect(getMeta(db, 'schema_version')).toBe(String(CURRENT)));
      expect(up).toHaveBeenCalledTimes(1);
    } finally {
      up.mockRestore();
    }
  });

  it('heals a lagging user_version without re-running a migration, then takes the fast path', () => {
    withDb((db) => db.exec(`PRAGMA user_version = ${CURRENT - 1}`));
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    const up = vi.spyOn(last, 'up');
    try {
      withDb((db) => expect(userVersion(db)).toBe(CURRENT));
      expect(up).not.toHaveBeenCalled();
    } finally {
      up.mockRestore();
    }
    expect(openAndClose().filter((sql) => DDL.test(sql))).toEqual([]);
  });

  it('repairs a dropped continuity table and a dropped index', () => {
    withDb((db) => {
      db.exec('DROP TABLE card_comments');
      db.exec('DROP INDEX idx_memory_quarantine_status');
    });

    expect(openAndClose().some((sql) => DDL.test(sql))).toBe(true);
    withDb((db) => {
      expect(objectExists(db, 'card_comments')).toBe(true);
      expect(objectExists(db, 'idx_card_comments_tenant_card')).toBe(true);
      expect(objectExists(db, 'idx_memory_quarantine_status')).toBe(true);
    });
  });

  it('takes the slow path and restores a missing meta default key', () => {
    withDb((db) => db.prepare(`DELETE FROM meta WHERE key = 'total_recalled'`).run());

    expect(openAndClose().some((sql) => DDL.test(sql))).toBe(true);
    withDb((db) => expect(getMeta(db, 'total_recalled', 'missing')).toBe('0'));
  });
});

describe('full-text drift repair moved off the open path', () => {
  function desyncFts(): void {
    withDb((db) => db.prepare(`DELETE FROM memories_fts WHERE content LIKE '%quokka%'`).run());
  }

  it('a plain open leaves drift alone and sleep repairs it', async () => {
    desyncFts();
    withDb((db) => expect(ftsRowCounts(db)).toEqual({ memories: 1, fts: 0 }));

    const result = await consolidate(root);

    withDb((db) => {
      expect(ftsRowCounts(db)).toEqual({ memories: 1, fts: 1 });
      expect(db.prepare(`SELECT id FROM memories_fts WHERE memories_fts MATCH 'quokka'`).all()).toHaveLength(1);
    });
    expect(result.details.some((line) => line.includes('re-synced the full-text index'))).toBe(true);
  });

  it('doctor warns on drift and points at sleep', () => {
    const origHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = path.join(cwd, 'global');
    try {
      expect(runDoctor({ cwd, home: cwd, version: 'test' }).checks.find((c) => c.id === 'fts')).toMatchObject({ status: 'pass' });
      desyncFts();
      expect(runDoctor({ cwd, home: cwd, version: 'test' }).checks.find((c) => c.id === 'fts')).toMatchObject({ status: 'warn', fix: expect.stringMatching(/hippo sleep/) });
    } finally {
      if (origHome === undefined) delete process.env.HIPPO_HOME;
      else process.env.HIPPO_HOME = origHome;
    }
  });
});
