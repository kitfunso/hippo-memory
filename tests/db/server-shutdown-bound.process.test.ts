// A signal or crash shutdown that cannot finish ends the process at its bound; one that can finish still exits 0 on a signal.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { makeRoot, removeWhenStopped } from '../_helpers/make-root.js';
import { startNode, type StartedChild } from '../_helpers/started-child.js';
import { EVENT_DEADLINE_MS, waitFor } from '../_helpers/wait-for.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// The script's shutdownDrainMs plus the 10 s the store's threads get to close.
const DRAIN_MS = 200;
const BOUND_MS = DRAIN_MS + 10_000;
// The child exits BOUND_MS after the trigger; step 0 measured the whole run at 12.3 s.
const EXIT_MS = BOUND_MS + 5_000;

const homes: string[] = [];
const children: StartedChild[] = [];
const watchers: DatabaseSyncLike[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await child.stop();
  // After the children: a stuck one still holds the write lock.
  for (const db of watchers.splice(0)) closeHippoDb(db);
  for (const home of homes.splice(0)) await removeWhenStopped(home);
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

/** `hippo serve` as its CLI boots it, in a child that then runs `after`. */
function serveThen(home: string, after: readonly string[]): StartedChild {
  const script = join(home, 'serve-then.mjs');
  writeFileSync(
    script,
    [
      `const { serve } = await import(${JSON.stringify(pathToFileURL(resolve('dist', 'server.js')).href)});`,
      `const handle = await serve({ hippoRoot: ${JSON.stringify(home)}, port: 0, handleSignals: true, shutdownDrainMs: ${DRAIN_MS} });`,
      `const { readLocalKey } = await import(${JSON.stringify(pathToFileURL(resolve('dist', 'surface', 'server', 'local-key.js')).href)});`,
      `const auth = { authorization: 'Bearer ' + readLocalKey(${JSON.stringify(home)}) };`,
      ...after,
    ].join('\n'),
  );
  const child = startNode([script], {
    env: { ...process.env, HIPPO_HOME: join(home, '.global') },
    deadlineMs: EXIT_MS,
    reason: 'the store-close bound in src is 10 s',
  });
  children.push(child);
  return child;
}

function trackedRoot(): string {
  const home = makeRoot('shutdown-bound');
  homes.push(home);
  return home;
}

// The read first: it ends only after the store's writer thread has started and done its setup, so the write is that thread's only work.
// The write is never answered, so the script reports it sent and then waits for the test to see its statement running.
const STUCK_WRITE = [
  'const warm = await fetch(`${handle.url}/v1/predictions`, { headers: auth });',
  'if (warm.status !== 200) throw new Error(`the read answered ${warm.status}: ${await warm.text()}`);',
  "const body = JSON.stringify({ claim: 'stuck', classTag: 'release', estimate: 3, unit: 'days' });",
  "void fetch(`${handle.url}/v1/predictions`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body }).then((res) => console.log(`write answered ${res.status}`), (err) => console.log(`write failed: ${err.message}`));",
  "console.log('write sent');",
  "await new Promise((go) => process.stdin.once('data', go));",
];

/** Settles once another connection holds the store's write lock. The served store is idle but for the stuck write, so from then on its writer thread is inside that write. */
async function writeLockTaken(watcher: DatabaseSyncLike, served: StartedChild): Promise<void> {
  await waitFor(
    () => {
      try {
        watcher.exec('BEGIN IMMEDIATE');
        watcher.exec('ROLLBACK');
        return false;
      } catch (err) {
        if (String(err).includes('database is locked')) return true;
        throw err;
      }
    },
    { intervalMs: 25, what: 'the stuck write taking the write lock' },
  ).catch((err: Error) => {
    throw new Error(`${String(err)}
${served.output().stdout}${served.output().stderr}`);
  });
}

// A kill has no exit code of its own: Windows reports 1, and elsewhere the parent sees the signal.
const KILLED = process.platform === 'win32' ? { code: 1, signal: null } : { code: null, signal: 'SIGKILL' };

describe('serve() shutdown bound', () => {
  // Waits out the 10 s store-close bound in a child process before it can see the exit.
  it.each([
    ['SIGTERM', "process.emit('SIGTERM');"],
    ['uncaught exception', "setTimeout(() => { throw new Error('boom-bound'); }, 0);"],
  ])(
    'ends the process at the bound when a store thread stuck in a statement keeps stop() from finishing after %s',
    async (cause, trigger) => {
      const home = trackedRoot();
      const watcher = stickNextPredictionWrite(home);
      const served = serveThen(home, [...STUCK_WRITE, trigger]);
      await served.line(/^write sent$/, 'the stuck write sent', EVENT_DEADLINE_MS);
      await writeLockTaken(watcher, served);
      served.send('go\n');
      const triggeredAt = Date.now();

      const exit = await served.exited();
      expect({ code: exit.code, signal: exit.signal }, exit.stdout + exit.stderr).toEqual(KILLED);
      expect(Date.now() - triggeredAt).toBeGreaterThanOrEqual(BOUND_MS - 1000);
      const boundLines = exit.stderr.split('\n').filter((line) => line.includes('did not finish within'));
      expect(boundLines).toHaveLength(1);
      expect(boundLines[0]).toMatch(
        new RegExp(
          `^\\[hippo\\] error: serve shutdown after ${cause} did not finish within ${BOUND_MS} ms; ending the process without it`,
        ),
      );
    },
  );

  it('exits 0 on SIGTERM when stop() finishes, with no bound line', async () => {
    const served = serveThen(trackedRoot(), ["process.emit('SIGTERM');"]);

    const exit = await served.exited(EVENT_DEADLINE_MS);
    expect({ code: exit.code, signal: exit.signal }, exit.stdout + exit.stderr).toEqual({ code: 0, signal: null });
    expect(exit.stderr).toContain('received SIGTERM, shutting down');
    expect(exit.stderr).not.toContain('did not finish within');
  });
});
