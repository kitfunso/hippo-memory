// The Copilot hook commands through the built CLI, run from the home folder as VS Code runs user-level hooks, so the store must come from the payload's cwd.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { readDeliveryEvents, type DeliveryEventRow } from '../src/store/recall-trace.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { loadActiveTaskSnapshot, saveActiveTaskSnapshot } from '../src/store/sessions.js';
import type { JsonValue } from '../src/json.js';
import { compactionRows, initGlobal, initProject, runHippo } from './_helpers/compaction-hooks.js';
import {
  CLAUDE_SESSION, claudeCodePayload, copilotEventsJsonl, copilotPayload, copilotScratch, writeClaudeTranscript, writeCopilotSessionLog, type CopilotScratch,
} from './_helpers/copilot-hooks.js';

const CONTEXT_ARGS = ['context', '--pinned-only', '--include-recent', '5', '--format', 'copilot'];
const PROJ_PIN = 'The proj auth client keeps its retry budget in src/auth/retry.ts';
const GLOBAL_PIN = 'Global pin: prefer small pull requests over large ones';
const SESSION = 'copilot-sess-1';
const WORKER_DONE = `active snapshot(s) for session ${SESSION}`;
// Forward slashes, since NODE_OPTIONS reads a backslash as an escape.
const RECORD_SPAWN = path.resolve(__dirname, '_helpers', 'record-spawn.cjs').split(path.sep).join('/');

let s: CopilotScratch;

function pin(text: string, global: boolean): void {
  const r = runHippo(['remember', text, '--pin', ...(global ? ['--global'] : [])], s.proj, s.env);
  expect(r.status, r.stderr).toBe(0);
}

function patchConfig(hippoRoot: string, patch: { [key: string]: JsonValue }): void {
  const file = path.join(hippoRoot, 'config.json');
  // SAFETY: config.json is a JSON object hippo init wrote, or absent.
  const config = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}) as { [key: string]: JsonValue };
  fs.writeFileSync(file, JSON.stringify({ ...config, ...patch }));
}

function enableLedger(hippoRoot: string): void {
  patchConfig(hippoRoot, { deliveryLedger: { enabled: true } });
}

function deliveryEvents(sessionId: string): DeliveryEventRow[] {
  const db = openHippoDb(s.hippoRoot);
  try {
    return readDeliveryEvents(db, 'default', sessionId);
  } finally {
    closeHippoDb(db);
  }
}

interface LedgerRow { session_id: string | null; event: string }
interface FailureRow { session_id: string | null; tool: string | null; outcome: string; skip_rule: string | null }

function rows<T>(sql: string, hippoRoot = s.hippoRoot): T[] {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: every caller names the columns its row type declares.
    return db.prepare(sql).all() as T[];
  } finally {
    closeHippoDb(db);
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLog(logFile: string, marker: string, timeoutMs = 25_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (text.includes(marker)) return text;
    await sleepMs(50);
  }
  throw new Error(`${marker} not logged within ${timeoutMs}ms`);
}

beforeEach(() => {
  s = copilotScratch();
  initProject(s);
  initGlobal(s);
});

afterEach(() => {
  try {
    fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // The detached session-end worker can still hold a Windows lock; a leftover scratch dir is harmless.
  }
});

describe('hippo context --format copilot', () => {
  beforeEach(() => {
    pin(PROJ_PIN, false);
    pin(GLOBAL_PIN, true);
  });

  // Payloads from docs.github.com/en/copilot/reference/hooks-reference; reply formats from the same page and VS Code's toolCallingLoop.ts.
  it('answers a camelCase sessionStart with top-level additionalContext from the payload cwd store (critic test 1)', () => {
    const r = runHippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('sessionStart', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const reply = JSON.parse(r.stdout);
    expect(Object.keys(reply)).toEqual(['additionalContext']);
    expect(reply.additionalContext).toContain(PROJ_PIN);
    expect(reply.additionalContext).toContain(GLOBAL_PIN);
  });

  it('answers a snake_case SessionStart from the home folder with the nested reply and the same store (critic test 2)', () => {
    const r = runHippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('SessionStart', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const reply = JSON.parse(r.stdout);
    expect(Object.keys(reply)).toEqual(['hookSpecificOutput']);
    expect(reply.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(reply.hookSpecificOutput.additionalContext).toContain(PROJ_PIN);
  });

  it('without the copilot format the same run from the home folder never sees the project store', () => {
    const r = runHippo([...CONTEXT_ARGS.slice(0, -1), 'additional-context'], s.dir, s.env, copilotPayload('sessionStart', s.proj));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(GLOBAL_PIN);
    expect(r.stdout).not.toContain(PROJ_PIN);
  });

  it('sends the whole block again when the same session starts again, since session start is its only injection', () => {
    const payload = copilotPayload('sessionStart', s.proj);
    const first = runHippo(CONTEXT_ARGS, s.dir, s.env, payload);
    const again = runHippo(CONTEXT_ARGS, s.dir, s.env, payload);
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).additionalContext).toBe(JSON.parse(first.stdout).additionalContext);
  });

  it('books the delivery event and the token ledger under the session id with runtime copilot (critic test 3)', () => {
    enableLedger(s.hippoRoot);
    expect(runHippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('sessionStart', s.proj)).status).toBe(0);
    expect(runHippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('SessionStart', s.proj)).status).toBe(0);
    for (const sessionId of [SESSION, 'vscode-sess-1']) {
      const events = deliveryEvents(sessionId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ runtime: 'copilot', session_id: sessionId, session_state: 'payload', block_state: 'sent' });
    }
    const ledger = rows<LedgerRow>(`SELECT session_id, event FROM token_ledger ORDER BY rowid`);
    expect(ledger).toEqual([{ session_id: SESSION, event: 'inject' }, { session_id: 'vscode-sess-1', event: 'inject' }]);
  });
});

describe('hippo capture-error --runtime copilot (critic test 5)', () => {
  // postToolUseFailure payloads from the GH hooks reference; the error strings are synthetic, as neither harness documents them.
  it('stores no memory for a quiet grep or bash failure, and logs both in the payload cwd store', () => {
    for (const name of ['postToolUseFailureGrep', 'postToolUseFailureBash'] as const) {
      const r = runHippo(['capture-error', '--runtime', 'copilot'], s.dir, s.env, copilotPayload(name, s.proj));
      expect(r.status, r.stderr).toBe(0);
    }
    expect(loadAllEntries(s.hippoRoot).filter((e) => e.tags.includes('error'))).toEqual([]);
    expect(rows<FailureRow>(`SELECT session_id, tool, outcome, skip_rule FROM failure_log ORDER BY rowid`)).toEqual([
      { session_id: SESSION, tool: 'grep', outcome: 'skipped-routine', skip_rule: 'search-tool' },
      { session_id: SESSION, tool: 'bash', outcome: 'skipped-routine', skip_rule: 'quiet-exit' },
    ]);
  });

  it('stores a real failure in the payload cwd store', () => {
    const r = runHippo(['capture-error', '--runtime', 'copilot'], s.dir, s.env, copilotPayload('postToolUseFailureBuild', s.proj));
    expect(r.status, r.stderr).toBe(0);
    expect(loadAllEntries(s.hippoRoot).filter((e) => e.tags.includes('error')).map((e) => e.content)).toEqual([
      'bash: Command failed with exit code 2: tsc reported TS2345 in src/auth/client.ts',
    ]);
  });
});

describe('hippo session-end --runtime copilot (critic test 6)', () => {
  // sessionEnd payload from the GH hooks reference: it names no transcript, so the CLI log is found by session id.
  it('with no transcript for the session still sleeps, skips capture and exits 0', async () => {
    const logFile = path.join(s.dir, 'session-end.log');
    const r = runHippo(['session-end', '--runtime', 'copilot', '--log-file', logFile], s.dir, s.env, copilotPayload('sessionEnd', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const log = await waitForLog(logFile, WORKER_DONE);
    expect(log).toContain('consolidating memory...');
    expect(log).toContain('skip capture: no transcript for this session');
  });

  it('captures the session from <COPILOT_HOME>/session-state/<id>/events.jsonl', async () => {
    writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'session-end.log');
    const r = runHippo(['session-end', '--runtime', 'copilot', '--log-file', logFile], s.dir, s.env, copilotPayload('sessionEnd', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const log = await waitForLog(logFile, WORKER_DONE);
    expect(log).toContain('capturing session...');
    expect(log).not.toContain('skip capture');
    expect(loadAllEntries(s.hippoRoot).some((e) => e.content.includes('retry budget at three attempts'))).toBe(true);
  });

  it('with no --log-file logs to copilot-sleep.log under the hippo logs folder, the file the hooks table used to name', async () => {
    const r = runHippo(['session-end', '--runtime', 'copilot'], s.dir, s.env, copilotPayload('sessionEnd', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const log = await waitForLog(path.join(s.dir, '.hippo', 'logs', 'copilot-sleep.log'), WORKER_DONE);
    expect(log).toContain('consolidating memory...');
  });
});

describe('hippo pre-compact --runtime copilot (critic test 7)', () => {
  // preCompact payload from the GH hooks reference, its transcriptPath pointing at the events.jsonl fixture.
  it('saves a working-state snapshot, opens no compaction record and prints nothing', () => {
    const transcript = writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = runHippo(['pre-compact', '--runtime', 'copilot', '--log-file', logFile], s.dir, s.env, copilotPayload('preCompact', s.proj, transcript));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(compactionRows(s.hippoRoot)).toEqual([]);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('snapshot saved');
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toMatchObject({
      task: 'fix the flaky login test in auth.spec.ts', session_id: SESSION, source: 'pre-compact',
    });
  });

  it('skips a second run for the same compaction, as the Copilot CLI may fire both preCompact and PreCompact', () => {
    const transcript = writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'pre-compact.log');
    for (let run = 0; run < 2; run++) {
      const r = runHippo(['pre-compact', '--runtime', 'copilot', '--log-file', logFile], s.dir, s.env, copilotPayload('preCompact', s.proj, transcript));
      expect(r.status, r.stderr).toBe(0);
    }
    const log = fs.readFileSync(logFile, 'utf8');
    expect(log.match(/snapshot saved/g)).toHaveLength(1);
    expect(log).toContain(`skip: snapshot for session ${SESSION} saved under 10 s ago`);
    expect(rows<{ n: number }>(`SELECT COUNT(*) AS n FROM task_snapshots`)).toEqual([{ n: 1 }]);
  });

  it('with no payload it never falls back to scanning Claude Code transcripts', () => {
    const claudeLog = path.join(s.dir, '.claude', 'projects', 'other', 'claude-sess.jsonl');
    fs.mkdirSync(path.dirname(claudeLog), { recursive: true });
    fs.writeFileSync(claudeLog, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'a claude code task' } })}\n`);
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = runHippo(['pre-compact', '--runtime', 'copilot', '--log-file', logFile], s.proj, s.env, '');
    expect(r.status, r.stderr).toBe(0);
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toBeNull();
  });

  it('the same payload without the flag opens a record, as Claude Code has a PostCompact hook to close it', () => {
    const transcript = writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = runHippo(['pre-compact', '--log-file', logFile], s.proj, s.env, copilotPayload('preCompact', s.proj, transcript));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toBe('');
    expect(compactionRows(s.hippoRoot)).toHaveLength(1);
  });
});

const VSCODE_SESSION = 'vscode-sess-1';
const TURN_DONE = 'skip snapshot close: turn mode';
const SECOND_TURN = [
  { type: 'user.message', data: { content: 'now run the auth suite in CI on every pull request', attachments: [] }, id: 'e13', timestamp: '2026-10-07T12:01:00.000Z', parentId: 'e12' },
  { type: 'assistant.turn_start', data: { turnId: '1.0' }, id: 'e14', timestamp: '2026-10-07T12:01:01.000Z', parentId: 'e13' },
  { type: 'assistant.message', data: { messageId: 'm5', content: 'We decided to run the auth suite on every pull request in CI.', toolRequests: [] }, id: 'e15', timestamp: '2026-10-07T12:01:02.000Z', parentId: 'e14' },
  { type: 'assistant.turn_end', data: { turnId: '1.0' }, id: 'e16', timestamp: '2026-10-07T12:01:03.000Z', parentId: 'e15' },
].map((line) => `${JSON.stringify(line)}\n`).join('');

/** Writes the chat log where VS Code keeps it, `<User>/workspaceStorage/<id>/github.copilot-chat/transcripts/<session id>.jsonl`. */
function writeVscodeTranscript(text: string): string {
  const file = path.join(s.dir, 'vscode-data', 'Code', 'User', 'workspaceStorage', 'h1', 'github.copilot-chat', 'transcripts', `${VSCODE_SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

describe('hippo session-end --runtime copilot --turn (the VS Code Stop hook)', () => {
  const logFile = (): string => path.join(s.dir, 'turn.log');
  const memoriesWith = (text: string): number => loadAllEntries(s.hippoRoot).filter((e) => e.content.includes(text)).length;

  /** One reply's Stop hook; the log starts afresh each turn, so the old one goes first. */
  async function stop(transcript: string): Promise<string> {
    fs.rmSync(logFile(), { force: true });
    const r = runHippo(['session-end', '--runtime', 'copilot', '--turn', '--log-file', logFile()], s.dir, s.env, copilotPayload('Stop', s.proj, transcript));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    return waitForLog(logFile(), TURN_DONE);
  }

  it('captures each reply once, keeps one handoff for the chat, and leaves the snapshot open', async () => {
    const transcript = writeVscodeTranscript(copilotEventsJsonl());
    saveActiveTaskSnapshot(s.hippoRoot, 'default', { task: 't', summary: 's', next_step: 'n', session_id: VSCODE_SESSION, source: 'pre-compact' });
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
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toMatchObject({ session_id: VSCODE_SESSION, status: 'active' });
  });

  it('rewrites the transcript handoff in place after each reply', async () => {
    const transcript = writeVscodeTranscript(copilotEventsJsonl());
    await stop(transcript);
    fs.appendFileSync(transcript, SECOND_TURN);
    const log = await stop(transcript);
    expect(log).toContain(`wrote handoff for session ${VSCODE_SESSION}`);
    const sql = `SELECT task_id FROM session_handoffs WHERE session_id = '${VSCODE_SESSION}'`;
    expect(rows<{ task_id: string | null }>(sql)).toEqual([{ task_id: 'now run the auth suite in CI on every pull request' }]);
  });

  it.each([
    ['below the threshold it skips sleep', { enabled: true, threshold: 50 }, /turn close, session vscode-sess-1: skip sleep, \d+ new memories, threshold 50\n/],
    ['with auto-sleep off it skips sleep', { enabled: false, threshold: 1 }, /turn close, session vscode-sess-1: skip sleep, auto-sleep is off\n/],
    ['at the threshold it sleeps', { enabled: true, threshold: 1 }, /consolidating memory\.\.\.[\s\S]*turn close, session vscode-sess-1: ran sleep at \d+ new memories \(threshold 1\)\n/],
  ])('%s', async (_name, autoSleep, line) => {
    pin(PROJ_PIN, false);
    patchConfig(s.hippoRoot, { autoSleep });
    const log = await stop(writeVscodeTranscript(copilotEventsJsonl()));
    expect(log).toMatch(line);
    if (!autoSleep.enabled || autoSleep.threshold > 1) expect(log).not.toContain('consolidating memory...');
  });

  /** How many session-end workers one Stop hook run started; the preload records each spawn before the hook exits. */
  function workersStartedBy(payload: string): number {
    const record = path.join(s.dir, 'spawns.jsonl');
    fs.rmSync(record, { force: true });
    const env = { ...s.env, RECORD_SPAWN_FILE: record, NODE_OPTIONS: `${s.env.NODE_OPTIONS ?? ''} --require "${RECORD_SPAWN}"` };
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
});

describe('hippo pre-compact from Claude Code settings on a VS Code chat', () => {
  // With chat.useClaudeHooks on, VS Code runs ~/.claude/settings.json hooks too, so Claude Code's PreCompact line fires in Copilot chats.
  it('with hippo.json installed leaves the chat to the Copilot hook: no record, no summariser text, no snapshot', () => {
    fs.mkdirSync(path.join(s.copilotHome, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(s.copilotHome, 'hooks', 'hippo.json'), '{}');
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = runHippo(['pre-compact', '--log-file', logFile], s.proj, s.env, copilotPayload('PreCompact', s.proj, writeVscodeTranscript(copilotEventsJsonl())));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(compactionRows(s.hippoRoot)).toEqual([]);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('skip: VS Code payload, hippo.json runs pre-compact for this chat');
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toBeNull();
  });

  it('still saves the snapshot when hippo.json sits under a COPILOT_HOME elsewhere, as VS Code reads only ~/.copilot/hooks', () => {
    const elsewhere = path.join(s.dir, 'copilot-elsewhere');
    fs.mkdirSync(path.join(elsewhere, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'hooks', 'hippo.json'), '{}');
    const logFile = path.join(s.dir, 'pre-compact.log');
    const env = { ...s.env, COPILOT_HOME: elsewhere };
    const r = runHippo(['pre-compact', '--log-file', logFile], s.proj, env, copilotPayload('PreCompact', s.proj, writeVscodeTranscript(copilotEventsJsonl())));
    expect(r.status, r.stderr).toBe(0);
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toMatchObject({ session_id: VSCODE_SESSION, source: 'pre-compact' });
  });

  it('without hippo.json saves the snapshot alone and prints nothing, as no PostCompact will close a record', () => {
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = runHippo(['pre-compact', '--log-file', logFile], s.proj, s.env, copilotPayload('PreCompact', s.proj, writeVscodeTranscript(copilotEventsJsonl())));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(compactionRows(s.hippoRoot)).toEqual([]);
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toMatchObject({
      task: 'fix the flaky login test in auth.spec.ts', session_id: VSCODE_SESSION, source: 'pre-compact',
    });
  });
});

describe('a Claude Code payload run from another folder with no --runtime', () => {
  // Claude Code runs each hook in its project, so a payload cwd naming a different folder must not move the store.
  let other: string;
  let otherRoot: string;

  beforeEach(() => {
    other = path.join(s.dir, 'other');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    expect(runHippo(['init', '--no-hooks', '--no-schedule', '--no-learn'], other, s.env).status).toBe(0);
    otherRoot = path.join(other, '.hippo');
  });

  it('capture-error logs the failure in the store of the folder it runs in', () => {
    const r = runHippo(['capture-error'], other, s.env, claudeCodePayload('PostToolUseFailure', s.proj, writeClaudeTranscript(s.dir)));
    expect(r.status, r.stderr).toBe(0);
    const sql = `SELECT session_id FROM failure_log`;
    expect(rows<{ session_id: string | null }>(sql, otherRoot)).toEqual([{ session_id: CLAUDE_SESSION }]);
    expect(rows<{ session_id: string | null }>(sql)).toEqual([]);
  });

  it('pre-compact opens its record in the store of the folder it runs in', () => {
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = runHippo(['pre-compact', '--log-file', logFile], other, s.env, claudeCodePayload('PreCompact', s.proj, writeClaudeTranscript(s.dir)));
    expect(r.status, r.stderr).toBe(0);
    expect(compactionRows(otherRoot)).toHaveLength(1);
    expect(compactionRows(s.hippoRoot)).toEqual([]);
  });

  it('session-end closes the snapshot in the store of the folder it runs in and leaves the payload cwd store alone', async () => {
    for (const root of [otherRoot, s.hippoRoot]) {
      saveActiveTaskSnapshot(root, 'default', { task: 'fix the flaky login test', summary: 's', next_step: 'n', session_id: CLAUDE_SESSION, source: 'pre-compact' });
    }
    const logFile = path.join(s.dir, 'session-end.log');
    const r = runHippo(['session-end', '--log-file', logFile], other, s.env, claudeCodePayload('SessionEnd', s.proj, writeClaudeTranscript(s.dir)));
    expect(r.status, r.stderr).toBe(0);
    await waitForLog(logFile, `closed 1 active snapshot(s) for session ${CLAUDE_SESSION}`);
    expect(loadActiveTaskSnapshot(otherRoot, 'default')).toBeNull();
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toMatchObject({ session_id: CLAUDE_SESSION, status: 'active' });
  });
});
