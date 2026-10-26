// One session-end worker per session: a busy session queues the request for the running worker, and turn capture resumes from its cursor.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadTurnPosition,
  runSessionWorker,
  saveTurnPosition,
  turnPosition,
  turnsAfter,
  type WorkerMode,
} from '../../src/surface/capture/session-worker.js';
import type { SessionTurn } from '../../src/surface/capture/transcript.js';
import { withFakeHome, type FakeHomeHandle } from '../_helpers/with-fake-home.js';

const ID = 'vscode-sess-1';
let fake: FakeHomeHandle;
let sessions: string;
const file = (suffix: string): string => path.join(sessions, `${ID}${suffix}`);

beforeEach(() => {
  fake = withFakeHome('hippo-session-worker-');
  sessions = path.join(fake.home, '.hippo', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
});
afterEach(() => {
  fake.cleanup();
  vi.unstubAllEnvs();
});

/** A pid that named a process a moment ago and names none now. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  // The OS picks the pid, so only its sign is fixed; status 0 says the process ran and has exited.
  expect(r.status).toBe(0);
  expect(r.pid).toBeGreaterThan(0);
  return r.pid!;
}

interface Recorder {
  readonly runs: WorkerMode[];
  readonly work: (mode: WorkerMode) => Promise<void>;
}

function recorder(): Recorder {
  const runs: WorkerMode[] = [];
  return {
    runs,
    work: async (mode) => {
      runs.push(mode);
    },
  };
}

describe('runSessionWorker', () => {
  it('runs the request once and leaves no lock or queued file behind', async () => {
    const { runs, work } = recorder();
    await runSessionWorker(ID, 'turn', work);
    expect(runs).toEqual(['turn']);
    expect(fs.readdirSync(sessions)).toEqual([]);
  });

  it('queues the request for a live holder and returns without running it; a full close outranks a queued turn', async () => {
    const lock = `${process.ppid}:${Date.now()}`;
    fs.writeFileSync(file('.lock'), lock);
    const { runs, work } = recorder();
    await runSessionWorker(ID, 'turn', work);
    expect(fs.readFileSync(file('.queued'), 'utf8')).toBe('turn');
    await runSessionWorker(ID, 'full', work);
    await runSessionWorker(ID, 'turn', work);
    expect(runs).toEqual([]);
    expect(fs.readFileSync(file('.queued'), 'utf8')).toBe('full');
    expect(fs.readFileSync(file('.lock'), 'utf8')).toBe(lock);
  });

  it("takes over a dead holder's lock and runs the strongest queued request", async () => {
    fs.writeFileSync(file('.lock'), `${deadPid()}:${Date.now()}`);
    fs.writeFileSync(file('.queued'), 'full');
    const { runs, work } = recorder();
    await runSessionWorker(ID, 'turn', work);
    expect(runs).toEqual(['full']);
    expect(fs.readdirSync(sessions)).toEqual([]);
  });

  it('takes over a lock older than 15 minutes even when its pid names a live process, as Windows reuses pids', async () => {
    fs.writeFileSync(file('.lock'), `${process.ppid}:${Date.now() - 16 * 60 * 1000}`);
    const { runs, work } = recorder();
    await runSessionWorker(ID, 'turn', work);
    expect(runs).toEqual(['turn']);
    expect(fs.readdirSync(sessions)).toEqual([]);
  });

  it('respects an empty lock, which a taker has made but not yet written, until it is 15 minutes old', async () => {
    fs.writeFileSync(file('.lock'), '');
    const { runs, work } = recorder();
    await runSessionWorker(ID, 'turn', work);
    expect(runs).toEqual([]);
    expect(fs.readFileSync(file('.lock'), 'utf8')).toBe('');

    const old = new Date(Date.now() - 16 * 60 * 1000);
    fs.utimesSync(file('.lock'), old, old);
    await runSessionWorker(ID, 'turn', work);
    expect(runs).toEqual(['turn']);
    expect(fs.readdirSync(sessions)).toEqual([]);
  });

  it('lets only one of two acquirers in one process run at a time: the second queues and its run waits for the first', async () => {
    const events: string[] = [];
    let release = (): void => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = async (mode: WorkerMode): Promise<void> => {
      const run = events.filter((e) => e.startsWith('start')).length + 1;
      events.push(`start ${run} ${mode}`);
      if (run === 1) await firstHeld;
      events.push(`end ${run}`);
    };
    const first = runSessionWorker(ID, 'turn', work);
    await runSessionWorker(ID, 'turn', work);
    events.push('second returned');
    expect(fs.readFileSync(file('.queued'), 'utf8')).toBe('turn');
    release();
    await first;
    expect(events).toEqual(['start 1 turn', 'second returned', 'end 1', 'start 2 turn', 'end 2']);
    expect(fs.readdirSync(sessions)).toEqual([]);
  });

  it('runs a request that another reply queued while the work ran, before it lets go', async () => {
    const runs: WorkerMode[] = [];
    await runSessionWorker(ID, 'turn', async (mode) => {
      // What a second Stop hook's worker does when it finds the lock held: queue, then leave.
      if (runs.length === 0) fs.writeFileSync(file('.queued'), 'turn', { flag: 'wx' });
      runs.push(mode);
    });
    expect(runs).toEqual(['turn', 'turn']);
    expect(fs.readdirSync(sessions)).toEqual([]);
  });

  it.each([null, '../escape', 'a b'])('runs unlocked, writing nothing, for the session id %s', async (id) => {
    const { runs, work } = recorder();
    await runSessionWorker(id, 'full', work);
    expect(runs).toEqual(['full']);
    expect(fs.readdirSync(sessions)).toEqual([]);
  });

  it('refuses to run unlocked when the request cannot be queued', async () => {
    fs.rmSync(sessions, { recursive: true });
    fs.writeFileSync(sessions, 'a file where the sessions folder belongs');
    const { runs, work } = recorder();
    await runSessionWorker(ID, 'full', work);
    expect(runs).toEqual([]);
  });

  it('runs unlocked and warns once per lock path when the lock cannot be created', async () => {
    const real = nodeFs.writeFileSync;
    const denyLock = (
      p: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ): void => {
      if (String(p).endsWith('.lock')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      real(p, data, options);
    };
    const spy = vi.spyOn(nodeFs, 'writeFileSync').mockImplementation(denyLock);
    syncBuiltinESMExports();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { runs, work } = recorder();
      await runSessionWorker(ID, 'turn', work);
      await runSessionWorker(ID, 'turn', work);
      expect(runs).toEqual(['turn', 'turn']);
      const lines = write.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('cannot be created or cleared'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${ID}.lock`);
    } finally {
      write.mockRestore();
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('lets go of the lock when the work throws', async () => {
    await expect(
      runSessionWorker(ID, 'turn', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(file('.lock'))).toBe(false);
  });
});

describe('the progress cursor', () => {
  const turns: SessionTurn[] = [
    { role: 'user', text: 'fix the flaky login test' },
    { role: 'assistant', text: 'The retry budget stays at three.' },
    { role: 'user', text: 'now rerun the auth suite' },
    { role: 'assistant', text: 'The auth suite passes.' },
  ];

  it('gives the turns after the saved position, none when nothing is new, and all of them with no position', () => {
    expect(turnsAfter(turns, null)).toEqual(turns);
    expect(turnsAfter(turns, turnPosition(turns.slice(0, 2)))).toEqual(turns.slice(2));
    expect(turnsAfter(turns, turnPosition(turns))).toEqual([]);
    expect(turnPosition([])).toBe('0:');
    expect(turnsAfter(turns, '0:')).toEqual(turns);
  });

  it('finds its place by the last turn read when a tail read drops earlier turns, and reads all when that turn is gone', () => {
    const position = turnPosition(turns.slice(0, 3));
    expect(turnsAfter(turns.slice(1), position)).toEqual(turns.slice(3));
    expect(turnsAfter(turns.slice(3), position)).toEqual(turns.slice(3));
    expect(turnsAfter(turns, 'junk')).toEqual(turns);
  });

  it('saves the position as a ProgressCursor for this transcript only, and reads a torn file as none', () => {
    const transcript = path.join(fake.home, 'transcripts', `${ID}.jsonl`);
    expect(loadTurnPosition(ID, transcript)).toBeNull();
    saveTurnPosition(ID, transcript, turns, () => {});
    expect(JSON.parse(fs.readFileSync(file('.cursor.json'), 'utf8'))).toMatchObject({
      runtime: 'vscode',
      sessionId: ID,
      source: transcript,
      position: turnPosition(turns),
    });
    expect(loadTurnPosition(ID, transcript)).toBe(turnPosition(turns));
    expect(loadTurnPosition(ID, `${transcript}.other`)).toBeNull();
    fs.writeFileSync(file('.cursor.json'), '{"source":');
    expect(loadTurnPosition(ID, transcript)).toBeNull();
  });

  it('logs a cursor it cannot read, but not a torn one', () => {
    const transcript = path.join(fake.home, 'transcripts', `${ID}.jsonl`);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      fs.writeFileSync(file('.cursor.json'), '{"source":');
      expect(loadTurnPosition(ID, transcript)).toBeNull();
      expect(write).not.toHaveBeenCalled();
      fs.rmSync(file('.cursor.json'));
      fs.mkdirSync(file('.cursor.json'));
      expect(loadTurnPosition(ID, transcript)).toBeNull();
      expect(write.mock.calls.map((c) => String(c[0])).join('')).toMatch(
        /warn: session worker: cannot read the cursor .*errorClass=Error/,
      );
    } finally {
      write.mockRestore();
    }
  });

  it('logs a cursor it cannot save and goes on, so the digest and handoff still run', () => {
    const transcript = path.join(fake.home, 'transcripts', `${ID}.jsonl`);
    // A folder in the cursor's place makes the rename fail, as Windows does with EPERM while another process has the file open.
    fs.mkdirSync(path.join(file('.cursor.json'), 'held'), { recursive: true });
    const log: string[] = [];
    expect(() => saveTurnPosition(ID, transcript, turns, (m) => log.push(m))).not.toThrow();
    expect(log).toEqual([expect.stringMatching(/^cursor not saved: /)]);
  });
});
