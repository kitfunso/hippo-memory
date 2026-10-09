// Tells the server thread when a write job may have committed, so a job stopped before that point is known to have saved nothing.
import type { DatabaseSyncLike } from '../../db/index.js';

const ROLLS_BACK_PART = /^\s*ROLLBACK\s+TO\b/i;
// After any of these the connection may be in autocommit, where a statement prepared earlier commits on its own.
const ENDS_TRANSACTION = /^\s*(?:COMMIT|END|RELEASE|ROLLBACK)\b/i;
// Reads, and the statements that open a transaction: none makes a change durable on its own.
const NEVER_COMMITS = /^\s*(?:SELECT|BEGIN|SAVEPOINT|PRAGMA|EXPLAIN)\b/i;

/** Whether running `sql` on `db` can make a change durable. Anything the patterns do not know counts as a commit. */
function mayCommit(db: DatabaseSyncLike, sql: string): boolean {
  if (ROLLS_BACK_PART.test(sql)) return false;
  if (ENDS_TRANSACTION.test(sql)) return true;
  return db.isTransaction !== true && !NEVER_COMMITS.test(sql);
}

/** Calls `mark` before `db` is handed any statement that may commit. */
export function watchCommits(db: DatabaseSyncLike, mark: () => void): void {
  const exec = db.exec.bind(db);
  const prepare = db.prepare.bind(db);
  db.exec = (sql) => {
    if (mayCommit(db, sql)) mark();
    exec(sql);
  };
  db.prepare = (sql) => {
    if (mayCommit(db, sql)) mark();
    return prepare(sql);
  };
}
