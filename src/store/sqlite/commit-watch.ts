// Tells the server thread when a write job may have committed, so a job stopped before that point is known to have
// saved nothing.
import type { DatabaseSyncLike } from '../../db/index.js';

const ROLLS_BACK_PART = /^\s*ROLLBACK\s+TO\b/i;
// A transaction's writes become durable where it ends; ROLLBACK counts too, to err on the safe side.
const ENDS_TRANSACTION = /^\s*(?:COMMIT|END|RELEASE|ROLLBACK)\b/i;
// Reads, and the statements that open a transaction: none makes a change durable on its own.
const NEVER_COMMITS = /^\s*(?:SELECT|BEGIN|SAVEPOINT|PRAGMA|EXPLAIN)\b/i;

/** Whether running `sql` on `db` can make a change durable. Anything the patterns do not know counts as a commit. */
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

/** Checks at each run, not at prepare, so a statement the connection cached still marks the later job that runs it. */
function markingRuns(stmt: Statement, check: () => void): Statement {
  return {
    run: (...params) => {
      check();
      return stmt.run(...params);
    },
    get: <T>(...params: unknown[]): T => {
      check();
      return stmt.get<T>(...params);
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
