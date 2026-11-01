// Opening a current, whole store runs one probe and no DDL; anything stale or missing takes the self-healing slow path.
// Real SQLite stores throughout; the statement spy wraps node:sqlite and passes every call through.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { StoreRuntime } from '../../src/db/store-runtime.js';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { consolidate } from '../../src/index.js';
import { runDoctor } from '../../src/surface/cli/doctor.js';
import { diagnosticsBodies } from '../_helpers/cli-stores.js';
import {
  openHippoDb,
  closeHippoDb,
  getMeta,
  setMeta,
  ftsRowCounts,
  getCurrentSchemaVersion,
  withSharedStoreHandlesSync,
  type DatabaseSyncLike,
} from '../../src/db/index.js';
import { REQUIRED_SCHEMA_OBJECTS } from '../../src/db/required-objects.js';
import { HEALED_INDEXES, HEALED_TABLES } from '../../src/db/continuity-tables.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { openStore, storeFilesOf } from '../../src/store/sqlite/runtime/handles.js';
import { grantFor } from '../../src/store/sqlite/runtime/grant.js';
import { detailLines } from '../_helpers/sleep-lines.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; mirrors tests/store/fts-sync-check-count.test.ts.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: { prototype: { prepare: (sql: string) => object; exec: (sql: string) => void } };
};

const CURRENT = getCurrentSchemaVersion();
const DDL = /\b(CREATE|ALTER|DROP)\s/i;
const ANY_CREATE =
  /CREATE\s+(?:TEMP\w*\s+)?(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/gi;

let root: string;
let cwd: string;

beforeEach(() => {
  ({ base: cwd, root } = makeStore('open-fast-path'));
  writeEntry(
    root,
    createMemory('the quokka deploy key rotates every ninety days', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
  );
});

/** Every SQL string sent through exec or prepare while `fn` runs. */
function captureStatements(fn: () => void): string[] {
  const statements: string[] = [];
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalExec = DatabaseSync.prototype.exec;
  const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSyncLike,
    ...args: [string]
  ) {
    statements.push(args[0]);
    return originalPrepare.apply(this, args);
  });
  const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
    this: DatabaseSyncLike,
    ...args: [string]
  ) {
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

  it('every CREATE the slow path runs names a required object, and it re-asserts each one but a healed one', () => {
    withDb((db) => db.prepare(`DELETE FROM meta WHERE key = 'last_trace_id'`).run());

    const created = new Set(openAndClose().flatMap((sql) => [...sql.matchAll(ANY_CREATE)].map((m) => m[1])));
    // A healed table or index is created only when it is missing.
    const healed = new Set<string>([...HEALED_TABLES, ...HEALED_INDEXES]);

    expect([...created].filter((name) => !REQUIRED_SCHEMA_OBJECTS.includes(name))).toEqual([]);
    expect(REQUIRED_SCHEMA_OBJECTS.filter((name) => !created.has(name) && !healed.has(name))).toEqual([]);
    expect([...healed].filter((name) => !REQUIRED_SCHEMA_OBJECTS.includes(name))).toEqual([]);
    expect(REQUIRED_SCHEMA_OBJECTS).toContain('idx_memory_quarantine_status');
  });

  it('HEALED_INDEXES names every index the migrations put on a healed table, and each one exists', () => {
    const list = (names: readonly string[]): string => names.map(() => '?').join(', ');
    let made: string[] = [];
    withDb((db) => {
      const sql =
        `SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ` +
        `AND (tbl_name IN (${list(HEALED_TABLES)}) OR name IN (${list(HEALED_INDEXES)}))`;
      // SAFETY: one TEXT column named name.
      made = (db.prepare(sql).all(...HEALED_TABLES, ...HEALED_INDEXES) as Array<{ name: string }>).map(
        ({ name }) => name,
      );
    });
    expect(made.sort()).toEqual([...HEALED_INDEXES].sort());
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

describe('one open reads the store once', () => {
  const afterPragmas = (open: () => DatabaseSyncLike): string[] =>
    captureStatements(() => closeHippoDb(open())).filter((sql) => !sql.startsWith('PRAGMA '));
  const memoryRows = (db: DatabaseSyncLike): number =>
    // SAFETY: COUNT(*) returns one row with the one aliased column.
    Number((db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c);

  it('a current store with a memory opens on its PRAGMAs and the one probe, through openHippoDb and openStore', () => {
    // The runtime remembers the once-per-store steps the first open ran, as a CLI or server process does.
    const runtime = new StoreRuntime();
    const opts = { grant: grantFor({ runtime }) };
    try {
      closeHippoDb(openStore(root, opts));
      expect(afterPragmas(() => opts.grant.open(root))).toHaveLength(1);
      expect(afterPragmas(() => openStore(root, opts))).toHaveLength(1);
    } finally {
      runtime.dispose();
    }
  });

  it("a later openStore in one request asks once whether a memory row is there, for both of setup's steps", () => {
    withSharedStoreHandlesSync((session) => {
      const opts = { grant: grantFor({ session }) };
      openStore(root, opts);
      expect(captureStatements(() => openStore(root, opts))).toEqual(['SELECT 1 AS x FROM memories LIMIT 1']);
    });
  });

  it('a store emptied through another connection is re-read by the next openStore, which imports its markdown mirror again', () => {
    closeHippoDb(openStore(root, storeFilesOf(root).opens));
    withDb((db) => db.exec('DELETE FROM memories'));

    const db = openStore(root, storeFilesOf(root).opens);
    try {
      expect(memoryRows(db)).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('a request that empties the store on its own handle gets the same re-read from its next openStore', () => {
    withSharedStoreHandlesSync((session) => {
      const opts = { grant: grantFor({ session }) };
      const handle = openStore(root, opts);
      expect(memoryRows(handle)).toBe(1);
      handle.exec('DELETE FROM memories');

      expect(memoryRows(openStore(root, opts))).toBe(1);
    });
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
    expect(detailLines(result).some((line) => line.includes('re-synced the full-text index'))).toBe(true);
  });

  it('doctor warns on drift and points at sleep', async () => {
    vi.stubEnv('HIPPO_HOME', path.join(cwd, 'global'));
    expect(
      (await runDoctor({ diagnosticsBodies, tenantId: 'default', cwd, home: cwd, version: 'test' })).checks.find(
        (c) => c.id === 'fts',
      ),
    ).toMatchObject({ status: 'pass' });
    desyncFts();
    expect(
      (await runDoctor({ diagnosticsBodies, tenantId: 'default', cwd, home: cwd, version: 'test' })).checks.find(
        (c) => c.id === 'fts',
      ),
    ).toMatchObject({ status: 'warn', fix: expect.stringMatching(/hippo sleep/) });
  });
});
