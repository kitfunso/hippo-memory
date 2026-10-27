// The lock is the operating system's: one holder per file, freed the moment its holder dies.
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { takeFileLock, type FileIdentity, type StatFn } from '../../src/host/file-lock.js';
import { waitFor } from '../_helpers/wait-for.js';

const CONTENDER = join(import.meta.dirname, '..', '_helpers', 'lock-contender.mjs');
const HOLDER = join(import.meta.dirname, '..', '_helpers', 'lock-holder.mjs');
const FD_PROBE = join(import.meta.dirname, '..', '_helpers', 'lock-fd-probe.mjs');
const LOOPER = join(import.meta.dirname, '..', '_helpers', 'lock-looper.mjs');
const DIST_LOCK = join(import.meta.dirname, '..', '..', 'dist', 'host', 'file-lock.js');
const ROUNDS = 20;

// SAFETY: node:sqlite's DatabaseSync has this shape at runtime; the module ships no bundled types here.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
};

const made: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-file-lock-'));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const exited = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('close', () => resolve())));

const identity = (path: string): FileIdentity | undefined => {
  const s = statSync(path, { bigint: true, throwIfNoEntry: false });
  return s === undefined ? undefined : { dev: s.dev, ino: s.ino, ctimeNs: s.ctimeNs };
};

/** A stat whose answers change by a nanosecond on every call while `moving()` is true. */
function driftingStat(moving: () => boolean): StatFn {
  let n = 0n;
  return (path) => {
    const real = identity(path);
    return real === undefined || !moving() ? real : { ...real, ctimeNs: real.ctimeNs + ++n };
  };
}

async function raceRound(dir: string, reversed: boolean): Promise<string[]> {
  const ids = reversed ? ['b', 'a'] : ['a', 'b'];
  const children = ids.map((id) => spawn(process.execPath, [CONTENDER, dir, id, 'race.lock.db'], { stdio: 'ignore' }));
  await waitFor(() => ids.every((id) => existsSync(join(dir, `ready-${id}`))), {
    what: 'both contenders ready',
    timeoutMs: 20_000,
  });
  writeFileSync(join(dir, 'go'), '');
  await waitFor(() => ids.every((id) => existsSync(join(dir, `result-${id}.json`))), {
    what: 'both results',
    timeoutMs: 20_000,
  });
  const kinds = ids.map((id) => {
    const result: { kind: string } = JSON.parse(readFileSync(join(dir, `result-${id}.json`), 'utf8'));
    return result.kind;
  });
  writeFileSync(join(dir, 'done'), '');
  await Promise.all(children.map(exited));
  return kinds;
}

describe('two processes taking one file lock', () => {
  it('lets exactly one of them take it, in every round', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const kinds = await raceRound(scratch(), round % 2 === 1);
      expect(kinds.filter((k) => k === 'taken')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'held')).toHaveLength(1);
    }
  }, 120_000);

  it('frees the lock when its holder is killed', async () => {
    const path = join(scratch(), 's.lock.db');
    const child = spawn(process.execPath, [HOLDER, path], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    expect(takeFileLock(path).kind).toBe('held');
    child.kill('SIGKILL');
    await exited(child);
    await waitFor(
      () => {
        const take = takeFileLock(path);
        if (take.kind === 'taken') take.lock.release();
        return take.kind === 'taken';
      },
      { what: 'lock freed after the holder died' },
    );
  }, 30_000);
});

/** Runs `count` looper processes on one path and checks the log: no overlapping enter, no unusable, all exit 0. */
async function loopTakers(count: number, durationMs: number, holdMs: number): Promise<Set<string>> {
  const dir = scratch();
  const log = join(dir, 'log.txt');
  const kids = Array.from({ length: count }, () =>
    spawn(process.execPath, [LOOPER, join(dir, 'loop.lock.db'), log, String(durationMs), String(holdMs)], {
      stdio: 'ignore',
    }),
  );
  await Promise.all(kids.map(exited));
  expect(kids.map((kid) => kid.exitCode)).toEqual(kids.map(() => 0));
  let inside: string | null = null;
  const entered = new Set<string>();
  for (const line of readFileSync(log, 'utf8').trim().split(/\r?\n/)) {
    const [what, pid] = line.split(' ');
    expect(what, line).not.toBe('unusable');
    if (what === 'enter') {
      expect(inside, `${pid} entered while ${inside} was inside`).toBeNull();
      inside = pid;
      entered.add(pid);
    } else if (what === 'exit') {
      expect(inside).toBe(pid);
      inside = null;
    }
  }
  return entered;
}

describe('processes looping take and release', () => {
  it('four processes never overlap, never see an unusable lock, and each take it at least once', async () => {
    expect((await loopTakers(4, 2000, 2)).size).toBe(4);
  }, 60_000);

  it.each([2, 8])(
    '%i processes taking with no hold never overlap',
    async (count) => {
      await loopTakers(count, 3000, 0);
    },
    60_000,
  );
});

describe.skipIf(process.platform === 'win32')('a take through the create path', () => {
  // POSIX drops every fcntl lock a process holds on a file when any descriptor on it closes.
  it('does not drop a lock another thread of this process holds', () => {
    const out = spawnSync(process.execPath, [FD_PROBE, join(scratch(), 'p.lock.db')], { encoding: 'utf8' });
    expect(JSON.parse(out.stdout)).toEqual({ worker: 'taken', main: 'held', other: 'held' });
  });
});

describe('one process', () => {
  it('refuses a second take of a held path, here and in a worker thread', async () => {
    const path = join(scratch(), 's.lock.db');
    const first = takeFileLock(path);
    expect(first.kind).toBe('taken');
    expect(takeFileLock(path).kind).toBe('held');
    const code = `const { parentPort } = require('node:worker_threads');
      import(${JSON.stringify(pathToFileURL(DIST_LOCK).href)}).then((m) => parentPort.postMessage(m.takeFileLock(${JSON.stringify(path)}).kind));`;
    const worker = new Worker(code, { eval: true });
    const kind = await new Promise<string>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    expect(kind).toBe('held');
    if (first.kind === 'taken') first.lock.release();
  });

  it('takes a missing path, keeps the file at release, and the next take reuses it', () => {
    const path = join(scratch(), 's.lock.db');
    const first = takeFileLock(path);
    if (first.kind !== 'taken') throw new Error(`expected taken, got ${first.kind}`);
    const made = identity(path);
    first.lock.release();
    first.lock.release();
    expect(identity(path)).toEqual(made);
    const again = takeFileLock(path);
    expect(again.kind).toBe('taken');
    expect(identity(path)).toEqual(made);
    if (again.kind === 'taken') again.lock.release();
  });

  it('removes the file when its holder calls remove, and only then', () => {
    const path = join(scratch(), 's.lock.db');
    const take = takeFileLock(path);
    if (take.kind !== 'taken') throw new Error(`expected taken, got ${take.kind}`);
    take.lock.remove();
    expect(existsSync(path)).toBe(false);
  });

  it('takes on a later pass when the stat throws before the open', () => {
    const path = join(scratch(), 's.lock.db');
    let calls = 0;
    const stat: StatFn = (p) => {
      if (calls++ === 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return identity(p);
    };
    const take = takeFileLock(path, stat);
    expect(take.kind).toBe('taken');
    if (take.kind === 'taken') take.lock.release();
  });

  it('writes no journal file while the lock is held', () => {
    const path = join(scratch(), 's.lock.db');
    const take = takeFileLock(path);
    if (take.kind !== 'taken') throw new Error(`expected taken, got ${take.kind}`);
    expect(existsSync(`${path}-journal`)).toBe(false);
    take.lock.release();
  });

  it('is held, not taken, when the path is replaced and locked as the take starts', () => {
    const path = join(scratch(), 's.lock.db');
    writeFileSync(path, '');
    let rival: { exec(sql: string): void; close(): void } | undefined;
    let calls = 0;
    const stat: StatFn = (p) => {
      if (calls++ === 0) {
        unlinkSync(p);
        rival = new DatabaseSync(p);
        rival.exec('BEGIN EXCLUSIVE');
      }
      return identity(p);
    };
    try {
      expect(takeFileLock(path, stat).kind).toBe('held');
    } finally {
      rival?.close();
    }
  });

  it('gives unusable with the original error when the recovery stat throws', () => {
    const path = join(scratch(), 's.lock.db');
    mkdirSync(path);
    let calls = 0;
    const stat: StatFn = (p) => {
      if (calls++ > 0) throw new Error('stat failed');
      return identity(p);
    };
    const take = takeFileLock(path, stat);
    if (take.kind !== 'unusable') throw new Error(`expected unusable, got ${take.kind}`);
    const cause = take.cause;
    if (!(cause instanceof Error) || !('errcode' in cause)) throw new Error('the cause carries no errcode');
    expect(Number(cause.errcode) & 0xff).toBe(14);
  });

  it('reports a directory at the lock path as unusable, with the SQLite primary code', () => {
    const path = join(scratch(), 's.lock.db');
    mkdirSync(path);
    const take = takeFileLock(path);
    if (take.kind !== 'unusable') throw new Error(`expected unusable, got ${take.kind}`);
    const cause = take.cause;
    if (!(cause instanceof Error) || !('errcode' in cause)) throw new Error('the cause carries no errcode');
    expect(Number(cause.errcode) & 0xff).toBe(14);
  });

  it('counts a path that changes identity after the lock as held', () => {
    const path = join(scratch(), 's.lock.db');
    expect(
      takeFileLock(
        path,
        driftingStat(() => true),
      ).kind,
    ).toBe('held');
    const real = takeFileLock(path);
    expect(real.kind).toBe('taken');
    if (real.kind === 'taken') real.lock.release();
  });
});
