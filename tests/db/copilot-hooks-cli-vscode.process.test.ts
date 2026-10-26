// The Copilot hook commands on a VS Code chat: the Stop hook per turn, and Claude Code settings that fire on a VS Code chat.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getHippoDbPath } from '../../src/db/index.js';
import { compactionRows } from '../_helpers/compaction-hooks.js';
import { holdStoreWriteLock, releaseStoreWriteLock } from '../_helpers/store-write-lock.js';
import { waitFor } from '../_helpers/wait-for.js';
import {
  CLAUDE_SESSION,
  claudeCodePayload,
  copilotEventsJsonl,
  copilotPayload,
  writeClaudeTranscript,
  writeCopilotSessionLog,
} from '../_helpers/copilot-hooks.js';
import { loadActiveTaskSnapshot, loadAllEntries, saveActiveTaskSnapshot } from '../_helpers/root-forms.js';
import {
  runHippo,
  PROJ_PIN,
  RECORD_SPAWN,
  CURSOR_SAVE_FAULT,
  s,
  hippo,
  pin,
  patchConfig,
  rows,
  initStoreIn,
  WORKER_WAIT_MS,
  readLog,
  waitForLog,
  useCopilotScratch,
  removeScratch,
} from '../_helpers/copilot-hooks-cli.js';

useCopilotScratch();

let holder: ChildProcess | null = null;

afterEach(async () => {
  await releaseStoreWriteLock(holder);
  holder = null;
  removeScratch();
});

const VSCODE_SESSION = 'vscode-sess-1';
const TURN_DONE = 'skip snapshot close: turn mode';
const FIRST_LESSON = 'retry budget at three attempts';
const SECOND_LESSON = 'every pull request in CI';
const SECOND_TURN = [
  {
    type: 'user.message',
    data: { content: 'now run the auth suite in CI on every pull request', attachments: [] },
    id: 'e13',
    timestamp: '2026-10-07T12:01:00.000Z',
    parentId: 'e12',
  },
  {
    type: 'assistant.turn_start',
    data: { turnId: '1.0' },
    id: 'e14',
    timestamp: '2026-10-07T12:01:01.000Z',
    parentId: 'e13',
  },
  {
    type: 'assistant.message',
    data: {
      messageId: 'm5',
      content: 'We decided to run the auth suite on every pull request in CI.',
      toolRequests: [],
    },
    id: 'e15',
    timestamp: '2026-10-07T12:01:02.000Z',
    parentId: 'e14',
  },
  {
    type: 'assistant.turn_end',
    data: { turnId: '1.0' },
    id: 'e16',
    timestamp: '2026-10-07T12:01:03.000Z',
    parentId: 'e15',
  },
]
  .map((line) => `${JSON.stringify(line)}\n`)
  .join('');

/** Writes the chat log where VS Code keeps it, `<User>/workspaceStorage/<id>/github.copilot-chat/transcripts/<session id>.jsonl`. */
function writeVscodeTranscript(text: string, sessionId = VSCODE_SESSION): string {
  const file = path.join(
    s.dir,
    'vscode-data',
    'Code',
    'User',
    'workspaceStorage',
    'h1',
    'github.copilot-chat',
    'transcripts',
    `${sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

describe('hippo session-end --runtime copilot --turn (the VS Code Stop hook)', () => {
  const logFile = (): string => path.join(s.dir, 'turn.log');
  const memoriesWith = (text: string, hippoRoot = s.hippoRoot): number =>
    loadAllEntries(hippoRoot, 'default').filter((e) => e.content.includes(text)).length;
  const stopArgs = (log: string): string[] => ['session-end', '--runtime', 'copilot', '--turn', '--log-file', log];
  const sessionFile = (suffix: string, id = VSCODE_SESSION): string =>
    path.join(s.dir, '.hippo', 'sessions', `${id}${suffix}`);

  function stopPayload(transcript: string, over: { cwd?: string; sessionId?: string } = {}): string {
    const payload = copilotPayload('Stop', over.cwd ?? s.proj, transcript);
    if (over.sessionId === undefined) return payload;
    // SAFETY: copilotPayload returns the JSON object of one fixture.
    return JSON.stringify({ ...JSON.parse(payload), session_id: over.sessionId });
  }

  /** One reply's Stop hook; the log starts afresh each turn, so the old one goes first. */
  async function stop(
    transcript: string,
    run: { cwd?: string; from?: string; waitMs?: number; env?: NodeJS.ProcessEnv } = {},
  ): Promise<string> {
    fs.rmSync(logFile(), { force: true });
    const r = await hippo(
      stopArgs(logFile()),
      run.from ?? s.dir,
      run.env ?? s.env,
      stopPayload(transcript, { cwd: run.cwd }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    return waitForLog(logFile(), TURN_DONE, run.waitMs);
  }

  /** Env that stops the detached worker at the progress cursor save; `mark` gains the worker's pid line there. */
  function cursorSaveFault(mode: 'kill' | 'hold') {
    const mark = path.join(s.dir, 'cursor-save.mark');
    const releaseFile = path.join(s.dir, 'cursor-save.release');
    const env: NodeJS.ProcessEnv = {
      ...s.env,
      CURSOR_SAVE_FAULT: mode,
      CURSOR_SAVE_MARK: mark,
      CURSOR_SAVE_RELEASE: mode === 'hold' ? releaseFile : undefined,
      NODE_OPTIONS: `${s.env.NODE_OPTIONS ?? ''} --require "${CURSOR_SAVE_FAULT}"`,
    };
    const marked = (): string => (fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '');
    return {
      env,
      async reached(): Promise<number> {
        // A poll can see the file created and still empty, which must never parse as pid 0.
        await waitFor(() => marked().includes('\n'), {
          what: 'a worker reaching the progress cursor save',
          timeoutMs: 40_000,
        });
        const pid = Number(marked().split('\n')[0]);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad pid in the cursor save mark: ${marked()}`);
        return pid;
      },
      saves: (): number[] =>
        marked()
          .split('\n')
          .filter((line) => line !== '')
          .map(Number),
      release: (): void => fs.writeFileSync(releaseFile, ''),
    };
  }

  function pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // SAFETY: process.kill throws a NodeJS.ErrnoException.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  it('captures each reply once, keeps one handoff for the chat, and leaves the snapshot open', async () => {
    const transcript = writeVscodeTranscript(copilotEventsJsonl());
    saveActiveTaskSnapshot(s.hippoRoot, 'default', {
      task: 't',
      summary: 's',
      nextStep: 'n',
      sessionId: VSCODE_SESSION,
      source: 'pre-compact',
    });
    let log = await stop(transcript);
    expect(log).toContain('capturing session...');
    expect(memoriesWith('retry budget at three attempts')).toBe(1);

    log = await stop(transcript);
    expect(log).toContain('skip capture: no new turns since the last reply');

    fs.appendFileSync(transcript, SECOND_TURN);
    log = await stop(transcript);
    expect(log).toContain('capturing session...');
    expect(memoriesWith('every pull request in CI')).toBe(1);
    expect(memoriesWith('retry budget at three attempts')).toBe(1);
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toMatchObject({
      sessionId: VSCODE_SESSION,
      status: 'active',
    });
  });

  it('rewrites the transcript handoff in place after each reply', async () => {
    const transcript = writeVscodeTranscript(copilotEventsJsonl());
    await stop(transcript);
    fs.appendFileSync(transcript, SECOND_TURN);
    const log = await stop(transcript);
    expect(log).toContain(`wrote handoff for session ${VSCODE_SESSION}`);
    const sql = `SELECT task_id FROM session_handoffs WHERE session_id = '${VSCODE_SESSION}'`;
    expect(rows<{ task_id: string | null }>(sql)).toEqual([
      { task_id: 'now run the auth suite in CI on every pull request' },
    ]);
  });

  it.each([
    [
      'below the threshold it skips sleep',
      { enabled: true, threshold: 50 },
      /turn close, session vscode-sess-1: skip sleep, \d+ new memories, threshold 50\n/,
    ],
    [
      'with auto-sleep off it skips sleep',
      { enabled: false, threshold: 1 },
      /turn close, session vscode-sess-1: skip sleep, auto-sleep is off\n/,
    ],
    [
      'at the threshold it sleeps',
      { enabled: true, threshold: 1 },
      /consolidating memory\.\.\.[\s\S]*turn close, session vscode-sess-1: ran sleep at \d+ new memories \(threshold 1\)\n/,
    ],
  ])('%s', async (_name, autoSleep, line) => {
    await pin(PROJ_PIN, false);
    patchConfig(s.hippoRoot, { autoSleep });
    const log = await stop(writeVscodeTranscript(copilotEventsJsonl()));
    expect(log).toMatch(line);
    if (!autoSleep.enabled || autoSleep.threshold > 1) expect(log).not.toContain('consolidating memory...');
  });

  /** How many session-end workers one Stop hook run started; the preload records each spawn before the hook exits. */
  function workersStartedBy(payload: string): number {
    const record = path.join(s.dir, 'spawns.jsonl');
    fs.rmSync(record, { force: true });
    const env = {
      ...s.env,
      RECORD_SPAWN_FILE: record,
      NODE_OPTIONS: `${s.env.NODE_OPTIONS ?? ''} --require "${RECORD_SPAWN}"`,
    };
    const r = runHippo(['session-end', '--runtime', 'copilot', '--turn', '--log-file', logFile()], s.dir, env, payload);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    return fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('__session-end-worker').length - 1 : 0;
  }

  it('does nothing for the Copilot CLI agentStop on the same hook line, or for no payload', async () => {
    const transcript = writeVscodeTranscript(copilotEventsJsonl());
    for (const payload of [copilotPayload('agentStop', s.proj, transcript), '']) {
      expect(workersStartedBy(payload)).toBe(0);
    }
    expect(fs.existsSync(logFile())).toBe(false);
    expect(fs.existsSync(path.join(s.dir, '.hippo', 'sessions'))).toBe(false);

    // VS Code's Stop on the same line does start a worker, so the zeros above are not a blind recorder.
    expect(workersStartedBy(copilotPayload('Stop', s.proj, transcript))).toBe(1);
    await waitForLog(logFile(), TURN_DONE);
  });

  // A lock holder process, two bounded lock waits in the hook, then a worker that saves once the lock is gone.
  it('on a busy store saves nothing and no progress cursor, then saves once the lock is gone and not again', async () => {
    const transcript = writeVscodeTranscript(copilotEventsJsonl());
    holder = await holdStoreWriteLock(getHippoDbPath(s.hippoRoot), 120_000);
    const busy = await stop(transcript, { waitMs: 90_000 });
    expect(busy).toContain('capture failed: database is locked');
    await releaseStoreWriteLock(holder);
    expect(memoriesWith(FIRST_LESSON)).toBe(0);
    expect(fs.existsSync(sessionFile('.cursor.json'))).toBe(false);

    expect(await stop(transcript)).toContain('Captured 1 items (0 skipped as duplicates');
    expect(memoriesWith(FIRST_LESSON)).toBe(1);
    expect(fs.existsSync(sessionFile('.cursor.json'))).toBe(true);

    expect(await stop(transcript)).toContain('skip capture: no new turns since the last reply');
    expect(memoriesWith(FIRST_LESSON)).toBe(1);
  }, 98_000);

  it('after a worker is killed before the progress cursor save, the next reply keeps one copy and saves the cursor', async () => {
    const transcript = writeVscodeTranscript(copilotEventsJsonl());
    const fault = cursorSaveFault('kill');
    const first = runHippo(stopArgs(logFile()), s.dir, fault.env, stopPayload(transcript));
    expect(first.status, first.stderr).toBe(0);
    const pid = await fault.reached();
    await waitFor(() => !pidAlive(pid), { what: `worker ${pid} dead`, timeoutMs: WORKER_WAIT_MS });
    expect(memoriesWith(FIRST_LESSON)).toBe(1);
    expect(fs.existsSync(sessionFile('.cursor.json'))).toBe(false);
    expect(fs.existsSync(sessionFile('.lock'))).toBe(true);
    // The temp file shows the kill landed between the write and the rename.
    expect(fs.existsSync(sessionFile(`.cursor.json.${pid}.tmp`))).toBe(true);

    expect(await stop(transcript)).toContain('Captured 0 items (1 skipped as duplicates');
    expect(memoriesWith(FIRST_LESSON)).toBe(1);
    expect(fs.existsSync(sessionFile('.cursor.json'))).toBe(true);
    await waitFor(() => !fs.existsSync(sessionFile('.lock')), {
      what: 'session lock released',
      timeoutMs: WORKER_WAIT_MS,
    });

    expect(await stop(transcript)).toContain('skip capture: no new turns since the last reply');
  });

  it("saves a reply that ends while the last reply's worker still runs, in that same worker", async () => {
    const transcript = writeVscodeTranscript(copilotEventsJsonl());
    const fault = cursorSaveFault('hold');
    fs.rmSync(logFile(), { force: true });
    const first = runHippo(stopArgs(logFile()), s.dir, fault.env, stopPayload(transcript));
    expect(first.status, first.stderr).toBe(0);
    const pid = await fault.reached();
    fs.appendFileSync(transcript, SECOND_TURN);
    const second = await hippo(stopArgs(logFile()), s.dir, s.env, stopPayload(transcript));
    expect(second.status, second.stderr).toBe(0);
    await waitFor(() => fs.existsSync(sessionFile('.queued')), {
      what: 'second reply queued',
      timeoutMs: WORKER_WAIT_MS,
    });
    fault.release();
    await waitFor(() => !fs.existsSync(sessionFile('.lock')), { what: 'session lock released', timeoutMs: 60_000 });
    expect(memoriesWith(FIRST_LESSON)).toBe(1);
    expect(memoriesWith(SECOND_LESSON)).toBe(1);
    // The second worker has no preload, so two lines with this pid mean the first worker saved the cursor twice.
    expect(fault.saves()).toEqual([pid, pid]);
    expect(readLog(logFile())).toContain('Captured 1 items (0 skipped as duplicates');
    expect(fs.existsSync(sessionFile('.queued'))).toBe(false);
    expect(fs.existsSync(sessionFile('.cursor.json'))).toBe(true);
  });

  it("keeps each lesson when a second chat ends a reply while the first chat's worker still runs", async () => {
    const second = 'vscode-sess-2';
    const secondLog = path.join(s.dir, 'turn-2.log');
    const fault = cursorSaveFault('hold');
    const firstStop = runHippo(
      stopArgs(logFile()),
      s.dir,
      fault.env,
      stopPayload(writeVscodeTranscript(copilotEventsJsonl())),
    );
    expect(firstStop.status, firstStop.stderr).toBe(0);
    // The first chat's worker is held at its cursor save before the second chat starts, so the whole second save falls inside that worker's life.
    const pid = await fault.reached();
    const secondPayload = stopPayload(writeVscodeTranscript(SECOND_TURN, second), { sessionId: second });
    const secondStop = await hippo(stopArgs(secondLog), s.dir, s.env, secondPayload);
    expect(secondStop.status, secondStop.stderr).toBe(0);
    await waitForLog(secondLog, TURN_DONE, 50_000);
    expect(pidAlive(pid)).toBe(true);
    expect(fs.existsSync(sessionFile('.lock'))).toBe(true);
    expect(memoriesWith(FIRST_LESSON)).toBe(1);
    expect(memoriesWith(SECOND_LESSON)).toBe(1);
    expect(fs.existsSync(sessionFile('.cursor.json'))).toBe(false);
    expect(fs.existsSync(sessionFile('.cursor.json', second))).toBe(true);

    fault.release();
    await waitFor(() => !fs.existsSync(sessionFile('.lock')), { what: 'session lock released', timeoutMs: 60_000 });
    expect(fs.existsSync(sessionFile('.cursor.json'))).toBe(true);
    expect(memoriesWith(FIRST_LESSON)).toBe(1);
    expect(memoriesWith(SECOND_LESSON)).toBe(1);
  });

  it('files a reply under the payload cwd project when that folder has no store', async () => {
    const billing = path.join(s.dir, 'billing');
    fs.mkdirSync(path.join(billing, '.git'), { recursive: true });
    await stop(writeVscodeTranscript(copilotEventsJsonl()), { cwd: billing, waitMs: 50_000 });
    const sql = `SELECT origin_project FROM memories WHERE instr(content, '${FIRST_LESSON}') > 0`;
    expect(rows<{ origin_project: string }>(sql, s.globalRoot)).toEqual([{ origin_project: 'billing' }]);
    expect(memoriesWith(FIRST_LESSON)).toBe(0);
    expect(fs.existsSync(path.join(billing, '.hippo'))).toBe(false);
  });

  it('saves into the payload cwd store when the hook runs from another project with its own store', async () => {
    const otherRoot = initStoreIn(path.join(s.dir, 'other'));
    await stop(writeVscodeTranscript(copilotEventsJsonl()), { from: path.join(s.dir, 'other'), waitMs: 50_000 });
    expect(memoriesWith(FIRST_LESSON)).toBe(1);
    expect(memoriesWith(FIRST_LESSON, otherRoot)).toBe(0);
    expect(memoriesWith(FIRST_LESSON, s.globalRoot)).toBe(0);
  });

  it("saves nothing for a transcript that is not on disk, with other chats' transcripts where a fallback could look", async () => {
    const beside = writeVscodeTranscript(copilotEventsJsonl(), 'vscode-sess-2');
    writeCopilotSessionLog(s.copilotHome, 'vscode-sess-2', copilotEventsJsonl());
    const claudeProject = path.join(s.dir, 'claude', 'projects', 'proj');
    fs.mkdirSync(claudeProject, { recursive: true });
    writeClaudeTranscript(claudeProject);
    const missing = path.join(path.dirname(beside), `${VSCODE_SESSION}.jsonl`);
    const log = await stop(missing, {
      env: { ...s.env, CLAUDE_CONFIG_DIR: path.join(s.dir, 'claude') },
      waitMs: 50_000,
    });
    expect(log).toContain('skip capture: no readable transcript for this session');
    for (const root of [s.hippoRoot, s.globalRoot]) {
      expect(rows<{ n: number }>('SELECT COUNT(*) AS n FROM memories', root)).toEqual([{ n: 0 }]);
    }
    expect(fs.existsSync(sessionFile('.cursor.json'))).toBe(false);
  });

  it('warns once when the payload cwd does not exist, and saves into the store of the folder it ran in', async () => {
    const other = path.join(s.dir, 'other');
    const otherRoot = initStoreIn(other);
    const payload = stopPayload(writeVscodeTranscript(copilotEventsJsonl()), { cwd: path.join(s.dir, 'gone') });
    fs.rmSync(logFile(), { force: true });
    const r = await hippo(stopArgs(logFile()), other, { ...s.env, HIPPO_LOG: 'warn' }, payload);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr.split('\n').filter((line) => line.includes('is not usable'))).toHaveLength(1);
    await waitForLog(logFile(), TURN_DONE, 50_000);
    expect(memoriesWith(FIRST_LESSON, otherRoot)).toBe(1);
    expect(memoriesWith(FIRST_LESSON)).toBe(0);
    expect(memoriesWith(FIRST_LESSON, s.globalRoot)).toBe(0);
  });
});

describe('hippo pre-compact from Claude Code settings on a VS Code chat', () => {
  // With chat.useClaudeHooks on, VS Code runs ~/.claude/settings.json hooks too, so Claude Code's PreCompact line fires in Copilot chats.
  it('with hippo.json installed leaves the chat to the Copilot hook: no record, no summariser text, no snapshot', async () => {
    fs.mkdirSync(path.join(s.copilotHome, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(s.copilotHome, 'hooks', 'hippo.json'), '{}');
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = await hippo(
      ['pre-compact', '--log-file', logFile],
      s.proj,
      s.env,
      copilotPayload('PreCompact', s.proj, writeVscodeTranscript(copilotEventsJsonl())),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(compactionRows(s.hippoRoot)).toEqual([]);
    expect(fs.readFileSync(logFile, 'utf8')).toContain(
      'skip: VS Code payload, hippo.json runs pre-compact for this chat',
    );
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toBeNull();
  });

  it('still saves the snapshot when hippo.json sits under a COPILOT_HOME elsewhere, as VS Code reads only ~/.copilot/hooks', async () => {
    const elsewhere = path.join(s.dir, 'copilot-elsewhere');
    fs.mkdirSync(path.join(elsewhere, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'hooks', 'hippo.json'), '{}');
    const logFile = path.join(s.dir, 'pre-compact.log');
    const env = { ...s.env, COPILOT_HOME: elsewhere };
    const r = await hippo(
      ['pre-compact', '--log-file', logFile],
      s.proj,
      env,
      copilotPayload('PreCompact', s.proj, writeVscodeTranscript(copilotEventsJsonl())),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toMatchObject({
      sessionId: VSCODE_SESSION,
      source: 'pre-compact',
    });
  });

  it('without hippo.json saves the snapshot alone and prints nothing, as no PostCompact will close a record', async () => {
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = await hippo(
      ['pre-compact', '--log-file', logFile],
      s.proj,
      s.env,
      copilotPayload('PreCompact', s.proj, writeVscodeTranscript(copilotEventsJsonl())),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(compactionRows(s.hippoRoot)).toEqual([]);
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toMatchObject({
      task: 'fix the flaky login test in auth.spec.ts',
      sessionId: VSCODE_SESSION,
      source: 'pre-compact',
    });
  });
});

describe('a Claude Code payload run from another folder with no --runtime', () => {
  // Claude Code runs each hook in its project, so a payload cwd naming a different folder must not move the store.
  let other: string;
  let otherRoot: string;

  beforeEach(() => {
    other = path.join(s.dir, 'other');
    otherRoot = initStoreIn(other);
  });

  it('capture-error logs the failure in the store of the folder it runs in', async () => {
    const r = await hippo(
      ['capture-error'],
      other,
      s.env,
      claudeCodePayload('PostToolUseFailure', s.proj, writeClaudeTranscript(s.dir)),
    );
    expect(r.status, r.stderr).toBe(0);
    const sql = `SELECT session_id FROM failure_log`;
    expect(rows<{ session_id: string | null }>(sql, otherRoot)).toEqual([{ session_id: CLAUDE_SESSION }]);
    expect(rows<{ session_id: string | null }>(sql)).toEqual([]);
  });

  it('pre-compact opens its record in the store of the folder it runs in', async () => {
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = await hippo(
      ['pre-compact', '--log-file', logFile],
      other,
      s.env,
      claudeCodePayload('PreCompact', s.proj, writeClaudeTranscript(s.dir)),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(compactionRows(otherRoot)).toHaveLength(1);
    expect(compactionRows(s.hippoRoot)).toEqual([]);
  });

  it('session-end closes the snapshot in the store of the folder it runs in and leaves the payload cwd store alone', async () => {
    for (const root of [otherRoot, s.hippoRoot]) {
      saveActiveTaskSnapshot(root, 'default', {
        task: 'fix the flaky login test',
        summary: 's',
        nextStep: 'n',
        sessionId: CLAUDE_SESSION,
        source: 'pre-compact',
      });
    }
    const logFile = path.join(s.dir, 'session-end.log');
    const r = await hippo(
      ['session-end', '--log-file', logFile],
      other,
      s.env,
      claudeCodePayload('SessionEnd', s.proj, writeClaudeTranscript(s.dir)),
    );
    expect(r.status, r.stderr).toBe(0);
    await waitForLog(logFile, `closed 1 active snapshot(s) for session ${CLAUDE_SESSION}`);
    expect(loadActiveTaskSnapshot(otherRoot, 'default')).toBeNull();
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toMatchObject({
      sessionId: CLAUDE_SESSION,
      status: 'active',
    });
  });
});
