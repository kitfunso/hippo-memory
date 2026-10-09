// A signal or crash shutdown that cannot finish ends the process at its bound; one that can finish still exits 0 on a signal.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import { makeRoot } from './_helpers/make-root.js';

// The script's shutdownDrainMs plus the 10 s the store's threads get to close.
const DRAIN_MS = 200;
const BOUND_MS = DRAIN_MS + 10_000;
// A loaded machine starts and ends a process slowly; past this the child counts as never exiting.
const MARGIN_MS = 10_000;
// How long the child gets to reach a state the test waits for.
const REACH_MS = 20_000;

const homes: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const watchers: DatabaseSyncLike[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const gone = new Promise((done) => child.once('exit', done));
    child.kill('SIGKILL');
    await gone;
  }
  // After the children: a stuck one still holds the write lock.
  for (const db of watchers.splice(0)) closeHippoDb(db);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A trigger that makes the next saved prediction run a statement for hours, so the store's writer thread cannot be stopped or closed. Returns a connection that watches the write lock. */
function stickNextPredictionWrite(root: string): DatabaseSyncLike {
  const db = openHippoDb(root);
  watchers.push(db);
  db.exec(`
    CREATE TABLE stuck_spin (x INTEGER);
    INSERT INTO stuck_spin WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 300) SELECT x FROM c;
    CREATE TRIGGER stuck_write AFTER INSERT ON predictions BEGIN
      SELECT count(*) FROM stuck_spin a, stuck_spin b, stuck_spin c, stuck_spin d, stuck_spin e WHERE a.x + b.x + c.x + d.x + e.x < 0;
    END;
    PRAGMA busy_timeout = 0;
  `);
  return db;
}

interface Served {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: () => string;
  /** What the child has written, for the message of a wait that gave up. */
  readonly output: () => string;
  /** Settles when the script prints `line`; fails with what the child wrote when it ends or 20 s pass first. */
  readonly printed: (line: string) => Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** `hippo serve` as its CLI boots it, in a child that then runs `after`. */
function serveThen(home: string, after: readonly string[]): Served {
  const script = join(home, 'serve-then.mjs');
  writeFileSync(script, [
    `const { serve } = await import(${JSON.stringify(pathToFileURL(resolve('dist', 'server.js')).href)});`,
    `const handle = await serve({ hippoRoot: ${JSON.stringify(home)}, port: 0, handleSignals: true, shutdownDrainMs: ${DRAIN_MS} });`,
    ...after,
  ].join('\n'));
  const child = spawn(process.execPath, [script], { env: { ...process.env, HIPPO_HOME: join(home, '.global') } });
  children.push(child);
  let stdout = '';
  let stderr = '';
  const waiting: Array<() => void> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    for (const check of waiting) check();
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const output = (): string => `stdout:\n${stdout}\nstderr:\n${stderr}`;
  // 'close' fires after stdio drains; 'exit' can beat the last stderr chunk.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.once('close', (code, signal) => done({ code, signal })));
  const printed = (line: string): Promise<void> => new Promise((done, fail) => {
    // A wait that only the runner's timeout ends leaves no evidence of what the child did.
    const giveUp = (why: string): void => fail(new Error(`${why} before the script printed "${line}"\n${output()}`));
    const timer = setTimeout(() => giveUp(`${REACH_MS} ms passed`), REACH_MS);
    void exited.then(({ code, signal }) => giveUp(`the child ended (code ${code}, signal ${signal})`));
    const check = (): void => {
      if (!stdout.split('\n').includes(line)) return;
      clearTimeout(timer);
      done();
    };
    waiting.push(check);
    check();
  });
  return { child, stderr: () => stderr, output, printed, exited };
}

function trackedRoot(): string {
  const home = makeRoot('shutdown-bound');
  homes.push(home);
  return home;
}

// The read first: it ends only after the store's writer thread has started and done its setup, so the write is that thread's only work.
// The write is never answered, so the script reports it sent and then waits for the test to see its statement running.
const STUCK_WRITE = [
  'const warm = await fetch(`${handle.url}/v1/predictions`);',
  'if (warm.status !== 200) throw new Error(`the read answered ${warm.status}: ${await warm.text()}`);',
  "const body = JSON.stringify({ claim: 'stuck', classTag: 'release', estimate: 3, unit: 'days' });",
  "void fetch(`${handle.url}/v1/predictions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((res) => console.log(`write answered ${res.status}`), (err) => console.log(`write failed: ${err.message}`));",
  "console.log('write sent');",
  "await new Promise((go) => process.stdin.once('data', go));",
];

/** Settles once another connection holds the store's write lock. The served store is idle but for the stuck write, so from then on its writer thread is inside that write. */
async function writeLockTaken(watcher: DatabaseSyncLike, served: Served): Promise<void> {
  const giveUpAt = Date.now() + REACH_MS;
  for (;;) {
    try {
      watcher.exec('BEGIN IMMEDIATE');
      watcher.exec('ROLLBACK');
    } catch (err) {
      if (String(err).includes('database is locked')) return;
      throw err;
    }
    if (Date.now() > giveUpAt) throw new Error(`the stuck write never took the write lock in ${REACH_MS} ms\n${served.output()}`);
    await new Promise((again) => setTimeout(again, 25));
  }
}

// A kill has no exit code of its own: Windows reports 1, and elsewhere the parent sees the signal.
const KILLED = process.platform === 'win32' ? { code: 1, signal: null } : { code: null, signal: 'SIGKILL' };

describe('serve() shutdown bound', () => {
  it.each([
    ['SIGTERM', "process.emit('SIGTERM');"],
    ['uncaught exception', "setTimeout(() => { throw new Error('boom-bound'); }, 0);"],
  ])('ends the process at the bound when a store thread stuck in a statement keeps stop() from finishing after %s', async (cause, trigger) => {
    const home = trackedRoot();
    const watcher = stickNextPredictionWrite(home);
    const served = serveThen(home, [...STUCK_WRITE, trigger]);
    await served.printed('write sent');
    await writeLockTaken(watcher, served);
    served.child.stdin.write('go\n');
    const triggeredAt = Date.now();

    const outcome = await Promise.race([
      served.exited,
      new Promise<'still running'>((done) => setTimeout(() => done('still running'), BOUND_MS + MARGIN_MS)),
    ]);

    expect(outcome, served.output()).toEqual(KILLED);
    expect(Date.now() - triggeredAt).toBeGreaterThanOrEqual(BOUND_MS - 1000);
    const boundLines = served.stderr().split('\n').filter((line) => line.includes('did not finish within'));
    expect(boundLines).toHaveLength(1);
    expect(boundLines[0]).toMatch(new RegExp(`^\\[hippo\\] error: serve shutdown after ${cause} did not finish within ${BOUND_MS} ms; ending the process without it`));
  }, 60_000);

  it('exits 0 on SIGTERM when stop() finishes, with no bound line', async () => {
    const served = serveThen(trackedRoot(), ["process.emit('SIGTERM');"]);

    expect(await served.exited).toEqual({ code: 0, signal: null });
    expect(served.stderr()).toContain('received SIGTERM, shutting down');
    expect(served.stderr()).not.toContain('did not finish within');
  }, 30_000);
});
