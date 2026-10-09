// A signal or crash shutdown that cannot finish ends the process at its bound; one that can finish still exits 0 on a signal.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { makeRoot } from './_helpers/make-root.js';

// The script's shutdownDrainMs plus the 10 s the store's threads get to close.
const DRAIN_MS = 200;
const BOUND_MS = DRAIN_MS + 10_000;
// A loaded machine starts and ends a process slowly; past this the child counts as never exiting.
const MARGIN_MS = 10_000;

const homes: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const gone = new Promise((done) => child.once('exit', done));
    child.kill('SIGKILL');
    await gone;
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A trigger that makes the next saved prediction run a statement for hours, so the store's writer thread cannot be stopped or closed. */
function stickNextPredictionWrite(root: string): void {
  const db = openHippoDb(root);
  try {
    db.exec(`
      CREATE TABLE stuck_spin (x INTEGER);
      INSERT INTO stuck_spin WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 300) SELECT x FROM c;
      CREATE TRIGGER stuck_write AFTER INSERT ON predictions BEGIN
        SELECT count(*) FROM stuck_spin a, stuck_spin b, stuck_spin c, stuck_spin d, stuck_spin e WHERE a.x + b.x + c.x + d.x + e.x < 0;
      END;
    `);
  } finally {
    closeHippoDb(db);
  }
}

interface Served {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: () => string;
  /** Settles when the script prints `line`. */
  readonly printed: (line: string) => Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** `hippo serve` as its CLI boots it, in a child that then runs `after`. */
function serveThen(home: string, after: readonly string[], env: NodeJS.ProcessEnv = {}): Served {
  const script = join(home, 'serve-then.mjs');
  writeFileSync(script, [
    `const { serve } = await import(${JSON.stringify(pathToFileURL(resolve('dist', 'server.js')).href)});`,
    `const handle = await serve({ hippoRoot: ${JSON.stringify(home)}, port: 0, handleSignals: true, shutdownDrainMs: ${DRAIN_MS} });`,
    ...after,
  ].join('\n'));
  const child = spawn(process.execPath, [script], { env: { ...process.env, HIPPO_HOME: join(home, '.global'), ...env } });
  children.push(child);
  let stdout = '';
  let stderr = '';
  const waiting: Array<() => void> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    for (const check of waiting) check();
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const printed = (line: string): Promise<void> => new Promise((done) => {
    const check = (): void => { if (stdout.split('\n').includes(line)) done(); };
    waiting.push(check);
    check();
  });
  // 'close' fires after stdio drains; 'exit' can beat the last stderr chunk.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.once('close', (code, signal) => done({ code, signal })));
  return { child, stderr: () => stderr, printed, exited };
}

function trackedRoot(): string {
  const home = makeRoot('shutdown-bound');
  homes.push(home);
  return home;
}

// The write is answered 504 at its request deadline while its statement still runs, so from this line on the writer thread is stuck.
const STUCK_WRITE = [
  "const res = await fetch(`${handle.url}/v1/predictions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim: 'stuck', classTag: 'release', estimate: 3, unit: 'days' }) });",
  'console.log(`answered ${res.status}`);',
];

// A kill has no exit code of its own: Windows reports 1, and elsewhere the parent sees the signal.
const KILLED = process.platform === 'win32' ? { code: 1, signal: null } : { code: null, signal: 'SIGKILL' };

describe('serve() shutdown bound', () => {
  it.each([
    ['SIGTERM', "process.emit('SIGTERM');"],
    ['uncaught exception', "setTimeout(() => { throw new Error('boom-bound'); }, 0);"],
  ])('ends the process at the bound when a store thread stuck in a statement keeps stop() from finishing after %s', async (cause, trigger) => {
    const home = trackedRoot();
    stickNextPredictionWrite(home);
    const served = serveThen(home, [...STUCK_WRITE, trigger], { HIPPO_REQUEST_DEADLINE_MS: '300' });
    await served.printed('answered 504');
    const triggeredAt = Date.now();

    const outcome = await Promise.race([
      served.exited,
      new Promise<'still running'>((done) => setTimeout(() => done('still running'), BOUND_MS + MARGIN_MS)),
    ]);

    expect(outcome).toEqual(KILLED);
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
