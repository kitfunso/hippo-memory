// One session-end worker per session: a busy session queues the request for the running worker, and turn capture resumes from its cursor.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  loadTurnPosition,
  pruneSessionFiles,
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
/** The sessions folder's files, leaving out the lock file a finished worker keeps for the next take. */
const left = (): string[] => fs.readdirSync(sessions).filter((n) => !n.endsWith('.lock.db'));
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

const HOLDER = path.join(import.meta.dirname, '..', '_helpers', 'lock-holder.mjs');

/** A child process that holds the lock file until it is killed. */
async function holdInChild(lock: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [HOLDER, lock], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
  return child;
}

const kill = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    child.once('close', () => resolve());
    child.kill('SIGKILL');
  });

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
    expect(left()).toEqual([]);
  });

  it('queues the request for a live holder and returns without running it; a full close outranks a queued turn', async () => {
    const holder = await holdInChild(file('.lock.db'));
    try {
      const { runs, work } = recorder();
      await runSessionWorker(ID, 'turn', work);
      expect(fs.readFileSync(file('.queued'), 'utf8')).toBe('turn');
      await runSessionWorker(ID, 'full', work);
      await runSessionWorker(ID, 'turn', work);
      expect(runs).toEqual([]);
      expect(fs.readFileSync(file('.queued'), 'utf8')).toBe('full');
      expect(fs.existsSync(file('.lock.db'))).toBe(true);
    } finally {
      await kill(holder);
    }
  });

  it("runs the strongest queued request once a killed holder's lock file is all that is left", async () => {
    await kill(await holdInChild(file('.lock.db')));
    fs.writeFileSync(file('.queued'), 'full');
    const { runs, work } = recorder();
    await runSessionWorker(ID, 'turn', work);
    expect(runs).toEqual(['full']);
    expect(left()).toEqual([]);
  });

  it('takes an empty lock file, which no live process holds', async () => {
    fs.writeFileSync(file('.lock.db'), '');
    const { runs, work } = recorder();
    await runSessionWorker(ID, 'turn', work);
    expect(runs).toEqual(['turn']);
    expect(left()).toEqual([]);
  });

  it('looks at the queue again after a release even when it ran nothing, and stops after five rounds', async () => {
    // A folder where takeQueued renames the request to makes every take fail: ran stays false and the request stays queued.
    fs.mkdirSync(file(`.queued.${process.pid}`));
    fs.writeFileSync(path.join(file(`.queued.${process.pid}`), 'keep'), '');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { runs, work } = recorder();
      await runSessionWorker(ID, 'turn', work);
      expect(runs).toEqual([]);
      const lines = write.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('cannot take the queued request'));
      expect(lines).toHaveLength(5);
    } finally {
      write.mockRestore();
    }
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
    expect(left()).toEqual([]);
  });

  it('runs a request that another reply queued while the work ran, before it lets go', async () => {
    const runs: WorkerMode[] = [];
    await runSessionWorker(ID, 'turn', async (mode) => {
      // What a second Stop hook's worker does when it finds the lock held: queue, then leave.
      if (runs.length === 0) fs.writeFileSync(file('.queued'), 'turn', { flag: 'wx' });
      runs.push(mode);
    });
    expect(runs).toEqual(['turn', 'turn']);
    expect(left()).toEqual([]);
  });

  it.each([null, '../escape', 'a b'])('runs unlocked, writing nothing, for the session id %s', async (id) => {
    const { runs, work } = recorder();
    await runSessionWorker(id, 'full', work);
    expect(runs).toEqual(['full']);
    expect(left()).toEqual([]);
  });

  it('refuses to run unlocked when the request cannot be queued', async () => {
    fs.rmSync(sessions, { recursive: true });
    fs.writeFileSync(sessions, 'a file where the sessions folder belongs');
    const { runs, work } = recorder();
    await runSessionWorker(ID, 'full', work);
    expect(runs).toEqual([]);
  });

  it('runs unlocked and warns once per lock path when the lock cannot be made', async () => {
    // A folder in the lock's place cannot be opened as a lock database.
    fs.mkdirSync(file('.lock.db'));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { runs, work } = recorder();
      await runSessionWorker(ID, 'turn', work);
      await runSessionWorker(ID, 'turn', work);
      expect(runs).toEqual(['turn', 'turn']);
      const lines = write.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('cannot be taken'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${ID}.lock.db`);
    } finally {
      write.mockRestore();
    }
  });

  it('lets go of the lock when the work throws', async () => {
    await expect(
      runSessionWorker(ID, 'turn', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(left()).toEqual([]);
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

describe('pruning the sessions folder', () => {
  const DAY = 86_400_000;
  const age = (name: string, days: number): void => {
    fs.writeFileSync(path.join(sessions, name), 'x');
    const then = new Date(Date.now() - days * DAY);
    fs.utimesSync(path.join(sessions, name), then, then);
  };

  it('removes an old cursor, an old cursor temp file and a day-old text lock', () => {
    age('a.cursor.json', 31);
    age('a.cursor.json.123.tmp', 31);
    age('a.lock', 2);
    expect(pruneSessionFiles(Date.now())).toBe(3);
    expect(left()).toEqual([]);
  });

  it('keeps fresh files, the lock database of any session and every queued request', () => {
    const keep = [
      'b.cursor.json',
      'b.cursor.json.123.tmp',
      'b.lock',
      'c.lock.db',
      'c.queued',
      'c.queued.99',
      'd.lock.db',
      'd.cursor.json',
    ];
    age('b.cursor.json', 29);
    age('b.cursor.json.123.tmp', 1);
    age('b.lock', 0);
    age('c.lock.db', 400);
    age('d.lock.db', 1);
    age('d.cursor.json', 1);
    age('c.queued', 400);
    age('c.queued.99', 400);
    expect(pruneSessionFiles(Date.now())).toBe(0);
    expect(fs.readdirSync(sessions).sort()).toEqual(keep.sort());
  });

  it('removes the lock file of a session idle past the cursor age, and keeps a young, held or queued one', async () => {
    const at = (name: string): string => path.join(sessions, name);
    fs.writeFileSync(at('idle.lock.db'), '');
    fs.writeFileSync(at('queued.lock.db'), '');
    fs.writeFileSync(at('queued.queued'), 'turn');
    const holder = await holdInChild(at('held.lock.db'));
    try {
      expect(pruneSessionFiles(Date.now())).toBe(0);
      expect(fs.existsSync(at('idle.lock.db'))).toBe(true);
      // ctime cannot be set, so the clock moves past the age instead.
      expect(pruneSessionFiles(Date.now() + 31 * DAY)).toBe(1);
      expect(fs.readdirSync(sessions).sort()).toEqual(['held.lock.db', 'queued.lock.db', 'queued.queued']);
    } finally {
      await kill(holder);
    }
  });

  it('does nothing, and does not throw, when the folder is missing', () => {
    fs.rmSync(sessions, { recursive: true });
    expect(pruneSessionFiles(Date.now())).toBe(0);
  });
});
