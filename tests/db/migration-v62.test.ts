// Schema v62 refuses a task snapshot or conflict status outside its list, and keeps every row already stored.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, getSchemaVersion, openHippoDb, setMeta, type DatabaseSyncLike } from '../../src/db/index.js';
import { v62 } from '../../src/db/migrations/v62.js';
import { CONFLICT_STATUSES } from '../../src/base/ports/store/conflicts.js';
import { SNAPSHOT_CLOSE_STATUSES } from '../../src/base/ports/store/sessions.js';
import { initStore } from '../../src/store/sqlite/runtime/handles.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from '../_helpers/schema-version.js';
import { listMemoryConflicts, replaceDetectedConflicts, writeEntriesTogether } from '../_helpers/root-forms.js';

// Every status a task snapshot row may hold: the two the store writes itself, then the close statuses.
const TASK_SNAPSHOT_STATUSES = ['active', 'superseded', ...SNAPSHOT_CLOSE_STATUSES] as const;

const SNAPSHOT_TRIGGERS = ['trg_task_snapshots_status_check_insert', 'trg_task_snapshots_status_check_update'];
const CONFLICT_TRIGGERS = ['trg_memory_conflicts_status_check_insert', 'trg_memory_conflicts_status_check_update'];
const SNAPSHOT_REFUSED = /invalid task snapshot status: must be active\|superseded\|cleared\|done\|session-ended/;
const CONFLICT_REFUSED = /invalid conflict status: must be open\|resolved/;
// The statuses a store at v61 held, as a scan of a real store found them, plus the one close status it had none of.
const SNAPSHOT_SCAN = ['active', 'done', 'session-ended', 'superseded', 'cleared'];
const CONFLICT_SCAN = ['open', 'resolved'];

function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function insertSnapshot(db: DatabaseSyncLike, status: string): void {
  db.prepare(
    `INSERT INTO task_snapshots (task, summary, next_step, status, source, created_at, updated_at) ` +
      `VALUES ('task', 'summary', 'next', ?, 'test', '2026-01-01', '2026-01-01')`,
  ).run(status);
}

function insertConflict(db: DatabaseSyncLike, pair: number, status: string): void {
  db.prepare(
    `INSERT INTO memory_conflicts (memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at) ` +
      `VALUES (?, ?, 'reason', 0.5, ?, '2026-01-01', '2026-01-01')`,
  ).run(`a-${pair}`, `b-${pair}`, status);
}

function statuses(db: DatabaseSyncLike, table: string): string[] {
  // SAFETY: the SELECT names one TEXT column, status.
  const rows = db.prepare(`SELECT status FROM ${table} ORDER BY id`).all() as Array<{ status: string }>;
  return rows.map((row) => row.status);
}

function allRows(db: DatabaseSyncLike, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
}

function triggerNames(db: DatabaseSyncLike): string[] {
  // SAFETY: the SELECT names one TEXT column, name.
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** Takes a current store back to v61's shape: none of v62's triggers, and both versions stamped 61. */
function toV61(db: DatabaseSyncLike): void {
  for (const name of [...SNAPSHOT_TRIGGERS, ...CONFLICT_TRIGGERS]) db.exec(`DROP TRIGGER ${name}`);
  setMeta(db, 'schema_version', '61');
  db.exec('PRAGMA user_version = 61');
}

interface ListedStatuses {
  when: string[];
  message: string[];
}

/** The values a trigger's WHEN list names, and the ones its message names. */
function listedBy(db: DatabaseSyncLike, trigger: string): ListedStatuses {
  // SAFETY: the SELECT names one TEXT column, sql.
  const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(trigger) as { sql: string };
  const list = /NOT IN \(([^)]*)\)/.exec(sql)![1];
  return {
    when: [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]),
    message: /must be ([^']+)'\)/.exec(sql)![1].split('|'),
  };
}

describe('migration v62', () => {
  it.each(TASK_SNAPSHOT_STATUSES)('a task snapshot takes %s on insert and on update', (status) => {
    withDb(makeRoot('migration-v62-snapshot-ok'), (db) => {
      insertSnapshot(db, 'active');
      db.prepare('UPDATE task_snapshots SET status = ?').run(status);
      insertSnapshot(db, status);
      expect(statuses(db, 'task_snapshots')).toEqual([status, status]);
    });
  });

  it.each(['session_end', ''])('a task snapshot refuses %j on insert and on update', (status) => {
    withDb(makeRoot('migration-v62-snapshot-bad'), (db) => {
      insertSnapshot(db, 'active');
      expect(() => insertSnapshot(db, status)).toThrow(SNAPSHOT_REFUSED);
      expect(() => db.prepare('UPDATE task_snapshots SET status = ?').run(status)).toThrow(SNAPSHOT_REFUSED);
      expect(statuses(db, 'task_snapshots')).toEqual(['active']);
    });
  });

  it.each(CONFLICT_STATUSES)('a conflict takes %s on insert and on update', (status) => {
    withDb(makeRoot('migration-v62-conflict-ok'), (db) => {
      insertConflict(db, 1, 'open');
      db.prepare('UPDATE memory_conflicts SET status = ?').run(status);
      insertConflict(db, 2, status);
      expect(statuses(db, 'memory_conflicts')).toEqual([status, status]);
    });
  });

  it('a conflict refuses dismissed on insert and on update', () => {
    withDb(makeRoot('migration-v62-conflict-bad'), (db) => {
      insertConflict(db, 1, 'open');
      expect(() => insertConflict(db, 2, 'dismissed')).toThrow(CONFLICT_REFUSED);
      expect(() => db.prepare(`UPDATE memory_conflicts SET status = 'dismissed'`).run()).toThrow(CONFLICT_REFUSED);
      expect(statuses(db, 'memory_conflicts')).toEqual(['open']);
    });
  });

  it('keeps every row and status a v61 store held through the migration', () => {
    const root = makeRoot('migration-v62-scan');
    const before = withDb(root, (db) => {
      toV61(db);
      SNAPSHOT_SCAN.forEach((status) => insertSnapshot(db, status));
      CONFLICT_SCAN.forEach((status, pair) => insertConflict(db, pair, status));
      return [allRows(db, 'task_snapshots'), allRows(db, 'memory_conflicts')];
    });

    initStore(root);

    withDb(root, (db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect([allRows(db, 'task_snapshots'), allRows(db, 'memory_conflicts')]).toEqual(before);
      expect(statuses(db, 'task_snapshots')).toEqual(SNAPSHOT_SCAN);
      expect(statuses(db, 'memory_conflicts')).toEqual(CONFLICT_SCAN);
      expect(triggerNames(db)).toEqual(expect.arrayContaining([...SNAPSHOT_TRIGGERS, ...CONFLICT_TRIGGERS]));
    });
  });

  it('leaves a legacy session_end snapshot as stored, editable, and unable to take another bad status', () => {
    const root = makeRoot('migration-v62-legacy');
    const before = withDb(root, (db) => {
      toV61(db);
      insertSnapshot(db, 'session_end');
      return allRows(db, 'task_snapshots');
    });

    initStore(root);

    withDb(root, (db) => {
      expect(allRows(db, 'task_snapshots')).toEqual(before);
      db.prepare(`UPDATE task_snapshots SET updated_at = '2026-02-02'`).run();
      expect(db.prepare('SELECT status, updated_at FROM task_snapshots').get()).toEqual({
        status: 'session_end',
        updated_at: '2026-02-02',
      });
      expect(() => db.prepare(`UPDATE task_snapshots SET status = 'bogus'`).run()).toThrow(SNAPSHOT_REFUSED);
      db.prepare(`UPDATE task_snapshots SET status = 'session-ended'`).run();
      expect(statuses(db, 'task_snapshots')).toEqual(['session-ended']);
    });
  });

  it('is a no-op the second time it runs, with each trigger present once', () => {
    withDb(makeRoot('migration-v62-twice'), (db) => {
      v62.up(db);
      v62.up(db);
      const names = triggerNames(db);
      for (const name of [...SNAPSHOT_TRIGGERS, ...CONFLICT_TRIGGERS]) {
        expect(names.filter((found) => found === name)).toEqual([name]);
      }
    });
  });

  it.each([
    { table: 'task_snapshots', triggers: SNAPSHOT_TRIGGERS, constant: TASK_SNAPSHOT_STATUSES },
    { table: 'memory_conflicts', triggers: CONFLICT_TRIGGERS, constant: CONFLICT_STATUSES },
  ])('the lists on $table equal the status constant the store code reads', ({ triggers, constant }) => {
    withDb(makeRoot('migration-v62-parity'), (db) => {
      for (const trigger of triggers) {
        const { when, message } = listedBy(db, trigger);
        expect(when.sort()).toEqual([...constant].sort());
        expect(message.sort()).toEqual([...constant].sort());
      }
    });
  });

  it('lets the conflict detect upsert reopen a resolved row', async () => {
    const root = makeRoot('migration-v62-upsert');
    const a = createMemory('deploys run from the main branch');
    const b = createMemory('deploys never run from the main branch');
    writeEntriesTogether(root, [a, b]);
    const detected = [{ memoryAId: a.id, memoryBId: b.id, reason: 'contradictory deploy advice', score: 0.9 }];
    replaceDetectedConflicts(root, detected);
    withDb(root, (db) => db.prepare(`UPDATE memory_conflicts SET status = 'resolved'`).run());
    expect(await listMemoryConflicts(root, 'open')).toEqual([]);

    replaceDetectedConflicts(root, detected);

    expect(await listMemoryConflicts(root, 'open')).toHaveLength(1);
    expect(withDb(root, (db) => statuses(db, 'memory_conflicts'))).toEqual(['open']);
  });
});
