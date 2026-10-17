// A real store connection, so isTransaction is the driver's own answer, not a stand-in.
import { afterEach, describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import { watchCommits } from '../src/store/sqlite/commit-watch.js';
import { makeRoot } from './_helpers/make-root.js';

const opened: DatabaseSyncLike[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeHippoDb(db);
});

interface Watched {
  readonly db: DatabaseSyncLike;
  readonly marks: () => number;
}

function watched(): Watched {
  const dir = makeRoot('commit-watch');
  const db = openHippoDb(dir);
  opened.push(db);
  db.exec('CREATE TABLE t (v INTEGER)');
  let count = 0;
  watchCommits(db, () => { count++; });
  return { db, marks: () => count };
}

describe('watchCommits', () => {
  it('marks an autocommit write, and the row it wrote is there', () => {
    const { db, marks } = watched();
    db.prepare('INSERT INTO t (v) VALUES (?)').run(7);
    expect(marks()).toBe(1);
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 7 }]);
    expect(marks()).toBe(1);
  });

  it('marks nothing for writes inside a transaction until its COMMIT', () => {
    const { db, marks } = watched();
    db.exec('BEGIN');
    db.exec('INSERT INTO t (v) VALUES (1)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run(2);
    db.exec('SAVEPOINT s');
    db.exec('ROLLBACK TO s');
    expect(marks()).toBe(0);
    db.exec('COMMIT');
    expect(marks()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 2 });
  });

  it('counts reads and pragmas as never committing, and an unknown statement as a commit', () => {
    const { db, marks } = watched();
    db.exec('PRAGMA user_version');
    db.prepare('EXPLAIN SELECT 1').all();
    expect(marks()).toBe(0);
    db.exec('CREATE INDEX t_v ON t (v)');
    expect(marks()).toBe(1);
  });
});
