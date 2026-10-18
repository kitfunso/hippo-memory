// SessionEnd in a folder with no store of its own saves into the global store, or nothing when there is none.
// Real built CLI and real stores, no mocks.
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';
import {
  loadActiveTaskSnapshot,
  loadLatestHandoff,
  loadAllEntries,
  saveActiveTaskSnapshot,
} from '../_helpers/root-forms.js';
import { initStore } from '../../src/store/sqlite/handles.js';
const RULE = 'Never run npm install in the billing service';
const USER_TEXT = `We decided to use pnpm for the billing service. ${RULE}; the lockfile is pnpm-lock.yaml.`;

let dir: string;
let cwd: string;
let globalRoot: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = makeRoot('session-end-global', { init: false });
  cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  globalRoot = path.join(dir, 'global');
  env = { ...process.env, HIPPO_HOME: globalRoot, HOME: dir, USERPROFILE: dir };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.HIPPO_SESSION_ID;
});

function worker(args: string[]) {
  return runCliAs(args, { cwd, env });
}

function writeClaudeTranscript(): string {
  const file = path.join(dir, 'session.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: USER_TEXT } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted, I will use pnpm.' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

async function runSessionEnd(sessionId: string) {
  const logFile = path.join(dir, 'session-end.log');
  const result = await worker([
    '__session-end-worker',
    '--transcript',
    writeClaudeTranscript(),
    '--session-id',
    sessionId,
    '--log-file',
    logFile,
  ]);
  return { logFile, status: result.status };
}

const contents = (root: string): string[] => loadAllEntries(root, 'default').map((e) => e.content);

describe('__session-end-worker with no store in the folder', () => {
  it('captures into the global store, makes no folder store, and skips sleep', async () => {
    initStore(globalRoot);

    const { logFile, status } = await runSessionEnd('sess-global-capture');

    expect(status).toBe(0);
    expect(contents(globalRoot).some((c) => c.includes(RULE))).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.hippo'))).toBe(false);
    const log = fs.readFileSync(logFile, 'utf8');
    expect(log).not.toContain('No hippo store');
    expect(log).toContain('skip sleep: this folder has no store of its own');
    expect(log).not.toContain('consolidating memory');
  });

  it('keeps the folder project on rows it saves to the global store', async () => {
    initStore(globalRoot);
    fs.mkdirSync(path.join(cwd, '.git'));

    expect((await runSessionEnd('sess-global-origin')).status).toBe(0);

    // Capture splits the turn into sentences, and only the 'Never' sentence holds the rule.
    const saved = loadAllEntries(globalRoot, 'default').filter((e) => e.content.includes(RULE));
    expect(saved).toHaveLength(1);
    expect(saved.every((e) => e.originProject === 'work')).toBe(true);
  });

  it('saves its own copy of a lesson another project already holds in the global store', async () => {
    initStore(globalRoot);
    const other = path.join(dir, 'other');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.git'));
    const home = cwd;
    cwd = other;
    expect((await runSessionEnd('sess-other-project')).status).toBe(0);
    cwd = home;

    expect((await runSessionEnd('sess-this-project')).status).toBe(0);

    const origins = loadAllEntries(globalRoot, 'default')
      .filter((e) => e.content.includes(RULE))
      .map((e) => e.originProject);
    expect(origins).toContain('other');
    expect(origins).toContain('work');
  });

  it('starts the log afresh when it skips sleep, as sleep does', async () => {
    initStore(globalRoot);
    fs.writeFileSync(path.join(dir, 'session-end.log'), 'stale line from an earlier run\n');

    const { logFile } = await runSessionEnd('sess-fresh-log');

    expect(fs.readFileSync(logFile, 'utf8')).not.toContain('stale line');
  });

  it('closes the session snapshot and writes the handoff in the global store', async () => {
    initStore(globalRoot);
    saveActiveTaskSnapshot(globalRoot, 'default', {
      task: 'billing service lockfile task',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-global-close',
      source: 'pre-compact',
    });

    const { logFile, status } = await runSessionEnd('sess-global-close');

    expect(status).toBe(0);
    const log = fs.readFileSync(logFile, 'utf8');
    expect(log).toContain('closed 1 active snapshot(s) for session sess-global-close');
    expect(log).toContain('wrote handoff for session sess-global-close');
    expect(loadActiveTaskSnapshot(globalRoot, 'default')).toBeNull();
    expect(loadLatestHandoff(globalRoot, 'default', 'sess-global-close')?.taskId).toBe('billing service lockfile task');
  });

  it('with no store anywhere, exits 0, creates no store and logs the skip in a fresh log', async () => {
    fs.writeFileSync(path.join(dir, 'session-end.log'), 'stale line from an earlier run\n');

    const { logFile, status } = await runSessionEnd('sess-no-store');

    expect(status).toBe(0);
    expect(fs.existsSync(path.join(cwd, '.hippo'))).toBe(false);
    expect(fs.existsSync(globalRoot)).toBe(false);
    const log = fs.readFileSync(logFile, 'utf8');
    expect(log).toContain('skip: no hippo store for this folder or globally');
    expect(log).not.toContain('stale line');
  });

  it('with a store of its own, still sleeps and captures into that store, not the global one', async () => {
    initStore(globalRoot);
    initStore(path.join(cwd, '.hippo'));

    const { logFile, status } = await runSessionEnd('sess-local');

    expect(status).toBe(0);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('consolidating memory');
    expect(contents(path.join(cwd, '.hippo')).some((c) => c.includes(RULE))).toBe(true);
    expect(contents(globalRoot)).toHaveLength(0);
  });
});

describe('__codex-session-end-worker with no store in the folder', () => {
  function writeCodexHome(): string {
    const codexHome = path.join(dir, 'codex');
    const sessions = path.join(codexHome, 'sessions', '2026', '09', '29');
    fs.mkdirSync(sessions, { recursive: true });
    const message = (role: string, type: string, text: string) => ({
      type: 'response_item',
      payload: { type: 'message', role, content: [{ type, text }] },
    });
    const lines = [
      message('user', 'input_text', USER_TEXT),
      message('assistant', 'output_text', 'Noted, I will use pnpm.'),
    ];
    fs.writeFileSync(
      path.join(sessions, 'rollout-2026-09-29T10-00-00-codex-1.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    return codexHome;
  }

  async function runCodexWorker(codexHome: string) {
    const logFile = path.join(dir, 'codex-session-end.log');
    const result = await worker([
      '__codex-session-end-worker',
      '--codex-home',
      codexHome,
      '--history-path',
      path.join(codexHome, 'history.jsonl'),
      '--started-at',
      '1',
      '--log-file',
      logFile,
    ]);
    return { logFile, status: result.status };
  }

  it('captures into the global store and skips sleep, in a fresh log', async () => {
    initStore(globalRoot);
    fs.writeFileSync(path.join(dir, 'codex-session-end.log'), 'stale line from an earlier run\n');

    const { logFile, status } = await runCodexWorker(writeCodexHome());
    expect(fs.readFileSync(logFile, 'utf8')).not.toContain('stale line');

    expect(status).toBe(0);
    expect(contents(globalRoot).some((c) => c.includes(RULE))).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.hippo'))).toBe(false);
    const log = fs.readFileSync(logFile, 'utf8');
    expect(log).not.toContain('No hippo store');
    expect(log).toContain('skip sleep: this folder has no store of its own');
  });

  it('keeps the folder project on rows it saves to the global store', async () => {
    initStore(globalRoot);
    fs.mkdirSync(path.join(cwd, '.git'));

    expect((await runCodexWorker(writeCodexHome())).status).toBe(0);

    const saved = loadAllEntries(globalRoot, 'default').filter((e) => e.content.includes(RULE));
    expect(saved).toHaveLength(1);
    expect(saved.every((e) => e.originProject === 'work')).toBe(true);
  });

  it('with no store anywhere, exits 0, creates no store and logs the skip', async () => {
    const { logFile, status } = await runCodexWorker(writeCodexHome());

    expect(status).toBe(0);
    expect(fs.existsSync(path.join(cwd, '.hippo'))).toBe(false);
    expect(fs.existsSync(globalRoot)).toBe(false);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('skip: no hippo store for this folder or globally');
  });
});
