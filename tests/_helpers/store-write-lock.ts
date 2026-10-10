// A second process that holds a store's write lock, as `hippo sleep` or another session's write does, so a test can show what a CLI does meanwhile.
import { spawn, type ChildProcess } from 'node:child_process';

const HOLDER_SRC = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
db.exec("UPDATE meta SET value = value WHERE key = 'schema_version'");
process.stdout.write('locked\\n');
setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, Number(process.argv[2]));
`;

/** Resolves once a child process holds the write lock on `dbPath`. The child lets go after `holdMs` by itself, so a test that dies leaves no lock behind. */
export function holdStoreWriteLock(dbPath: string, holdMs = 30_000): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--no-warnings', '-e', HOLDER_SRC, dbPath, String(holdMs)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('locked')) resolve(child);
    });
    child.on('exit', (code) => reject(new Error(`lock holder exited early with ${code}`)));
  });
}

/** Kills the holder and waits until it is gone, which is when SQLite frees the lock. Safe to call twice. */
export async function releaseStoreWriteLock(holder: ChildProcess | null): Promise<void> {
  // A killed child keeps exitCode null and sets signalCode, so both are read.
  if (holder === null || holder.exitCode !== null || holder.signalCode !== null) return;
  const exited = new Promise((resolve) => holder.once('exit', resolve));
  holder.kill();
  await exited;
}
