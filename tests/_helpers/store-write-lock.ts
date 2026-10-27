// A second process that holds a store's write lock, as `hippo sleep` or another session's write does, so a test can show what a CLI does meanwhile.
import { startNode, type StartedChild } from './started-child.js';

const HOLDER_SRC = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
db.exec("UPDATE meta SET value = value WHERE key = 'schema_version'");
process.stdout.write('locked\\n');
process.stdin.on('end', () => { db.exec('ROLLBACK'); db.close(); }).resume();
`;

/** Resolves once a child process holds the write lock on `dbPath`. It lets go when its stdin ends, which a dead test's
 * pipe also does, so a test that dies leaves no lock behind. */
export async function holdStoreWriteLock(dbPath: string): Promise<StartedChild> {
  const child = startNode(['--no-warnings', '-e', HOLDER_SRC, dbPath]);
  await child.line(/^locked$/, `the write lock on ${dbPath} held`);
  return child;
}

/** Ends the holder's stdin and waits until it has exited, which is when SQLite frees the lock. Safe to call twice. */
export async function releaseStoreWriteLock(holder: StartedChild | null): Promise<void> {
  if (holder === null || !holder.running()) return;
  await holder.endInput();
  await holder.exited();
}
