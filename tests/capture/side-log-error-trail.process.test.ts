// A hook's own log file gets the error class and stack of a failure, as the structured log does, and the lock warning adds one key per error class.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { preCompactHook } from '../../src/surface/capture/compact.js';
import { runSessionWorker, saveTurnPosition } from '../../src/surface/capture/session-worker.js';
import { reportSessionEndFailure } from '../../src/surface/cli/hook-runtime.js';
import { readSessionScan } from '../../src/surface/capture/session-digest.js';
import { transcriptWorkingState } from '../../src/surface/capture/working-state.js';
import { normalizeHookPayload } from '../../src/surface/cli/stdin.js';
import { copilotEventsJsonl, copilotPayload, writeCopilotSessionLog } from '../_helpers/copilot-hooks.js';
import { dispose, project, type Project } from '../_helpers/delivery-boundary.js';
import type { LogFields } from '../../src/base/util/log.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { withFakeHome, type FakeHomeHandle } from '../_helpers/with-fake-home.js';

let p: Project;
let fake: FakeHomeHandle;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  p = project();
  fake = withFakeHome('hippo-side-log-');
  // The hook exits once stderr drains, so the stub answers the write callback.
  // SAFETY: the stub keeps only the write callback of write's overloads, which is all the hook waits on.
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((...args: Array<string | (() => void)>) => {
    for (const arg of args) if (arg instanceof Function) arg();
    return true;
  }) as never);
});
afterEach(() => {
  stderr.mockRestore();
  fake.cleanup();
  dispose(p);
  vi.unstubAllEnvs();
});

describe('the pre-compact log file', () => {
  it('records the class, stack and cause of a boundary callback that threw', async () => {
    // SAFETY: the stub returns instead of exiting, so the hook's tail runs; `never` only satisfies the exit signature.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const transcript = writeCopilotSessionLog(path.join(p.dir, '.copilot'), 'copilot-sess-1', copilotEventsJsonl());
      const logFile = path.join(p.dir, 'trail.log');
      await preCompactHook(p.hippoRoot, apiCtx(p.hippoRoot), {
        stdinText: normalizeHookPayload(copilotPayload('preCompact', p.cwd, transcript)),
        runtime: 'copilot',
        logFile,
        onBoundary: () => {
          throw new RangeError('boom', { cause: new Error('root') });
        },
      });
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      const line = fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .find((l) => l.includes('boundary callback failed'));
      expect(line).toContain('errorClass=RangeError');
      expect(line).toContain('stack=');
      expect(line).toContain('cause="Error: root"');
      expect(line?.split('\n')).toHaveLength(1);
    } finally {
      exit.mockRestore();
    }
  });
});

describe('the session-end log file', () => {
  it('records the class and stack of a failed step', () => {
    const logFile = path.join(fake.home, 'end.log');
    reportSessionEndFailure(logFile, 'sleep', new TypeError('bad input'));
    const text = fs.readFileSync(logFile, 'utf8');
    expect(text).toContain('sleep failed: bad input');
    expect(text).toContain('errorClass=TypeError');
    expect(text).toContain('stack=');
  });

  it('records the class and stack of a cursor it could not save', () => {
    const sessions = path.join(fake.home, '.hippo', 'sessions');
    // A folder in the cursor's place makes the rename fail.
    fs.mkdirSync(path.join(sessions, 'sess-1.cursor.json', 'held'), { recursive: true });
    const lines: Array<{ message: string; fields: LogFields | undefined }> = [];
    saveTurnPosition('sess-1', path.join(fake.home, 't.jsonl'), [{ role: 'user', text: 'a' }], (message, opts) =>
      lines.push({ message, fields: opts?.fields }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toMatch(/^cursor not saved: /);
    expect(lines[0].fields).toMatchObject({ errorClass: expect.any(String) });
  });
});

describe('a transcript the session-end steps cannot read', () => {
  interface Line {
    readonly message: string;
    readonly fields: LogFields | undefined;
  }
  // A transcript that was never written fails the read.
  const missing = (): string => path.join(fake.home, 'missing.jsonl');

  it('logs the digest read failure with the error fields', () => {
    const lines: Line[] = [];
    expect(readSessionScan(missing(), (message, opts) => lines.push({ message, fields: opts?.fields }))).toBeNull();
    expect(lines).toEqual([
      {
        message: expect.stringMatching(/^digest: could not read the transcript: /),
        fields: expect.objectContaining({ errorClass: expect.any(String), stack: expect.any(String) }),
      },
    ]);
  });

  it('logs the working-state read failure with the error fields', () => {
    const lines: Line[] = [];
    expect(
      transcriptWorkingState(missing(), (message, opts) => lines.push({ message, fields: opts?.fields })),
    ).toBeNull();
    expect(lines).toEqual([
      {
        message: expect.stringMatching(/^skip: could not read transcript tail: /),
        fields: expect.objectContaining({ errorClass: expect.any(String), stack: expect.any(String) }),
      },
    ]);
  });
});

describe('the unusable-lock warning', () => {
  it('warns once per error class, so other sessions with the same failure add no key', async () => {
    const sessions = path.join(fake.home, '.hippo', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const warned = (): number =>
      stderr.mock.calls.filter((c: unknown[]) => String(c[0]).includes('cannot be taken')).length;
    const run = async (id: string): Promise<void> => {
      // A folder in the lock's place cannot be opened as a lock database.
      fs.mkdirSync(path.join(sessions, `${id}.lock.db`), { recursive: true });
      await runSessionWorker(id, 'turn', async () => {});
    };
    await run('class-0');
    await run('class-0');
    await run('class-1');
    expect(warned()).toBe(1);
  });
});
