// Continuity-tables self-heal (2026-08-15 incident): a store stamped past a
// table's migration but missing it crashed every prompt; ensureContinuityTables fixes it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  initStore,
  saveActiveTaskSnapshot,
  appendSessionEvent,
  saveSessionHandoff,
} from '../src/store.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';

const REPO_ROOT = join(__dirname, '..');
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

const CONTINUITY_TABLES = ['task_snapshots', 'session_events', 'session_handoffs'] as const;

function tableNames(db: DatabaseSyncLike): string[] {
  // SAFETY: row shape guaranteed by the `SELECT name FROM sqlite_master` projection.
  return (db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as Array<{ name: string }>)
    .map((r) => r.name);
}

function getMeta(db: DatabaseSyncLike, key: string): string | undefined {
  // SAFETY: row shape guaranteed by the `SELECT value FROM meta` projection.
  const row = db
    .prepare(`SELECT value FROM meta WHERE key = ?`)
    .get(key) as { value?: string } | undefined;
  return row?.value;
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function columns(db: DatabaseSyncLike, table: string): ColumnInfo[] {
  // SAFETY: PRAGMA table_info always yields rows shaped like ColumnInfo.
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function indexNames(db: DatabaseSyncLike, table: string): string[] {
  // SAFETY: PRAGMA index_list always yields rows with a `name` column.
  return (db
    .prepare(`PRAGMA index_list(${table})`)
    .all() as Array<{ name: string }>)
    .map((r) => r.name)
    .sort();
}

describe('continuity tables self-heal, missing table after schema stamp', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-continuity-heal-'));
    initStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('heals a v41 store missing session_handoffs', () => {
    const db1 = openHippoDb(root);
    try {
      db1.exec('DROP TABLE session_handoffs');
      expect(getMeta(db1, 'schema_version')).toBe('41');
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      expect(tableNames(db2)).toContain('session_handoffs');
      expect(getMeta(db2, 'schema_version')).toBe('41');
    } finally {
      closeHippoDb(db2);
    }
  });

  it('heals all three continuity tables dropped in one open', () => {
    const db1 = openHippoDb(root);
    try {
      for (const table of CONTINUITY_TABLES) {
        db1.exec(`DROP TABLE ${table}`);
      }
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      const tables = tableNames(db2);
      for (const table of CONTINUITY_TABLES) {
        expect(tables).toContain(table);
      }
    } finally {
      closeHippoDb(db2);
    }
  });

  it('column parity: a healed table matches a fresh store exactly', () => {
    const freshDb = openHippoDb(root);
    const freshColumns: Record<string, ColumnInfo[]> = {};
    try {
      for (const table of CONTINUITY_TABLES) {
        freshColumns[table] = columns(freshDb, table);
      }
    } finally {
      closeHippoDb(freshDb);
    }

    for (const table of CONTINUITY_TABLES) {
      const healRoot = mkdtempSync(join(tmpdir(), 'hippo-continuity-heal-col-'));
      try {
        initStore(healRoot);
        const db1 = openHippoDb(healRoot);
        try {
          db1.exec(`DROP TABLE ${table}`);
        } finally {
          closeHippoDb(db1);
        }
        const db2 = openHippoDb(healRoot);
        try {
          expect(columns(db2, table)).toEqual(freshColumns[table]);
        } finally {
          closeHippoDb(db2);
        }
      } finally {
        rmSync(healRoot, { recursive: true, force: true });
      }
    }
  });

  it('index parity: a healed table matches a fresh store exactly', () => {
    const freshDb = openHippoDb(root);
    const freshIndexes: Record<string, string[]> = {};
    try {
      for (const table of CONTINUITY_TABLES) {
        freshIndexes[table] = indexNames(freshDb, table);
      }
    } finally {
      closeHippoDb(freshDb);
    }

    for (const table of CONTINUITY_TABLES) {
      const healRoot = mkdtempSync(join(tmpdir(), 'hippo-continuity-heal-idx-'));
      try {
        initStore(healRoot);
        const db1 = openHippoDb(healRoot);
        try {
          db1.exec(`DROP TABLE ${table}`);
        } finally {
          closeHippoDb(db1);
        }
        const db2 = openHippoDb(healRoot);
        try {
          expect(indexNames(db2, table)).toEqual(freshIndexes[table]);
        } finally {
          closeHippoDb(db2);
        }
      } finally {
        rmSync(healRoot, { recursive: true, force: true });
      }
    }
  });

  it('is a no-op on a healthy store', () => {
    saveActiveTaskSnapshot(root, 'default', {
      task: 'Sample task',
      summary: 'Sample summary',
      next_step: 'Sample next step',
      session_id: 'sess-healthy',
      source: 'test',
    });
    appendSessionEvent(root, 'default', {
      session_id: 'sess-healthy',
      event_type: 'note',
      content: 'Sample event content',
      source: 'test',
    });
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-healthy',
      summary: 'Sample handoff',
      nextAction: 'Sample next action',
      artifacts: [],
    });

    const countsBefore: Record<string, number> = {};
    const dbBefore = openHippoDb(root);
    try {
      for (const table of CONTINUITY_TABLES) {
        // SAFETY: COUNT(*) always returns a single row with a `c` column.
        const row = dbBefore.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
        countsBefore[table] = row.c;
      }
    } finally {
      closeHippoDb(dbBefore);
    }

    const dbAfter = openHippoDb(root);
    try {
      for (const table of CONTINUITY_TABLES) {
        // SAFETY: COUNT(*) always returns a single row with a `c` column.
        const row = dbAfter.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
        expect(row.c).toBe(countsBefore[table]);
      }
      expect(getMeta(dbAfter, 'schema_version')).toBe('41');
    } finally {
      closeHippoDb(dbAfter);
    }
  });

  it('heals task_snapshots on a store below v22, before the migrations that reference it', () => {
    // v4, v16 and v22 ALTER or read task_snapshots; a store that lost it below v22 died there.
    const db = openHippoDb(root);
    try {
      db.exec('DROP TABLE task_snapshots');
      db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run('19');
    } finally {
      closeHippoDb(db);
    }

    const healed = openHippoDb(root);
    try {
      expect(tableNames(healed)).toContain('task_snapshots');
      expect(getMeta(healed, 'schema_version')).toBe('41');
    } finally {
      closeHippoDb(healed);
    }
  });

  it('migrates a genuine pre-v16 task_snapshots shape and still ends at full parity', () => {
    // codex round 2: an index on tenant_id or scope created before v16/v23 add them throws.
    const db = openHippoDb(root);
    try {
      db.exec('DROP TABLE task_snapshots');
      db.exec(`
        CREATE TABLE task_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task TEXT NOT NULL,
          summary TEXT NOT NULL,
          next_step TEXT NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          session_id TEXT
        )
      `);
      db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run('15');
    } finally {
      closeHippoDb(db);
    }

    const migrated = openHippoDb(root);
    const fresh = mkdtempSync(join(tmpdir(), 'hippo-continuity-fresh-'));
    try {
      initStore(fresh);
      const a = openHippoDb(fresh);
      try {
        expect(getMeta(migrated, 'schema_version')).toBe('41');
        expect(columns(migrated, 'task_snapshots')).toEqual(columns(a, 'task_snapshots'));
        expect(indexNames(migrated, 'task_snapshots')).toEqual(indexNames(a, 'task_snapshots'));
      } finally {
        closeHippoDb(a);
      }
    } finally {
      closeHippoDb(migrated);
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('hippo context runs on the incident shape (compiled CLI, real store)', () => {
    // CLI resolves hippoRoot as <cwd>/.hippo, unlike the direct-hippoRoot
    // calls above, so this case needs its own project/.hippo pair.
    const projectDir = mkdtempSync(join(tmpdir(), 'hippo-continuity-heal-cli-'));
    const hippoDir = join(projectDir, '.hippo');
    try {
      initStore(hippoDir);
      saveActiveTaskSnapshot(hippoDir, 'default', {
        task: 'Resume the current branch cleanly',
        summary: 'Continuity self-heal regression coverage.',
        next_step: 'Verify context does not crash on missing tables.',
        session_id: 'sess-heal',
        source: 'test',
      });

      const db = openHippoDb(hippoDir);
      try {
        db.exec('DROP TABLE session_handoffs');
        db.exec('DROP TABLE session_events');
      } finally {
        closeHippoDb(db);
      }

      const env = { ...process.env, HIPPO_SESSION_ID: 'sess-heal' };

      expect(() => {
        execFileSync(process.execPath, [CLI_PATH, 'context', '--pinned-only', '--budget', '1500'], {
          cwd: projectDir,
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }).not.toThrow();

      expect(() => {
        execFileSync(process.execPath, [CLI_PATH, 'context', '--auto', '--budget', '1500'], {
          cwd: projectDir,
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }).not.toThrow();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
