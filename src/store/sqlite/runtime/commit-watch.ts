import type { DatabaseSyncLike } from '../../../db/index.js';

const ROLLS_BACK_PART = /^\s*ROLLBACK\s+TO\b/i;
const ENDS_TRANSACTION = /^\s*(?:COMMIT|END|RELEASE|ROLLBACK)\b/i;
const NEVER_COMMITS = /^\s*(?:SELECT|BEGIN|SAVEPOINT|PRAGMA|EXPLAIN)\b/i;

function mayCommit(db: DatabaseSyncLike, sql: string): boolean {
  if (ROLLS_BACK_PART.test(sql)) return false;
  if (ENDS_TRANSACTION.test(sql)) return true;
  return db.isTransaction !== true && !NEVER_COMMITS.test(sql);
}

type Statement = ReturnType<DatabaseSyncLike['prepare']>;

/** Calls `mark` before `db` runs any statement that may commit. */
export function watchCommits(db: DatabaseSyncLike, mark: () => void): void {
  const exec = db.exec.bind(db);
  const prepare = db.prepare.bind(db);
  db.exec = (sql) => {
    if (mayCommit(db, sql)) mark();
    exec(sql);
  };
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (NEVER_COMMITS.test(sql)) return stmt;
    return markingRuns(stmt, () => {
      if (mayCommit(db, sql)) mark();
    });
  };
}

function markingRuns(stmt: Statement, check: () => void): Statement {
  return {
    run: (...params) => {
      check();
      return stmt.run(...params);
    },
    get: (...params) => {
      check();
      return stmt.get(...params);
    },
    all: (...params) => {
      check();
      return stmt.all(...params);
    },
    iterate: (...params) => {
      check();
      return stmt.iterate(...params);
    },
  };
}
