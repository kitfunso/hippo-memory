// A second process that wins a write race for real: it takes hippo.db's write lock, runs its statements, and commits after a pause.
import { spawn } from 'node:child_process';
import { getHippoDbPath } from '../../src/db/index.js';

const WINNER_SRC = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
for (const sql of JSON.parse(process.argv[4])) db.exec(sql);
db.exec('BEGIN IMMEDIATE');
for (const sql of JSON.parse(process.argv[3])) db.exec(sql);
process.stdout.write('locked\\n');
setTimeout(() => { db.exec('COMMIT'); db.close(); }, Number(process.argv[2]));
`;

export interface StagedWinner {
  /** Resolves once the winner has committed and exited; await it after the loser returns. */
  readonly committed: Promise<void>;
}

/** A SQL string literal, so a test can put an id or text into a winner statement. */
export function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Resolves once the child holds the lock with `statements` applied and uncommitted; it commits `settleMs` later.
 * `beforeLock` runs first, for statements such as ATTACH that a transaction forbids. */
export function stageWinner(
  dbPath: string,
  statements: readonly string[],
  beforeLock: readonly string[] = [],
  settleMs = 1000,
): Promise<StagedWinner> {
  const args = [
    '--no-warnings',
    '-e',
    WINNER_SRC,
    dbPath,
    String(settleMs),
    JSON.stringify(statements),
    JSON.stringify(beforeLock),
  ];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const committed = new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`race winner exited with ${code}`))));
  });
  // The test awaits `committed` later; until then an unhandled rejection must not end the run.
  committed.catch(() => undefined);
  return new Promise((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('locked')) resolve({ committed });
    });
    child.on('exit', (code) => reject(new Error(`race winner exited early with ${code}`)));
  });
}

/** A winner whose rows another store already holds: the child copies `tables` from the scratch store, then runs `statements`. */
export function stageScratchWinner(
  hippoRoot: string,
  scratchRoot: string,
  tables: readonly string[],
  statements: readonly string[] = [],
): Promise<StagedWinner> {
  const copies = tables.map((table) => `INSERT INTO main.${table} SELECT * FROM scratch.${table}`);
  return stageWinner(
    getHippoDbPath(hippoRoot),
    [...copies, ...statements],
    [`ATTACH DATABASE ${sqlText(getHippoDbPath(scratchRoot))} AS scratch`],
  );
}
