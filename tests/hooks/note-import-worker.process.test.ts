// Claude Code's PostToolUse and PostCompact hooks hand the agent-note import to a detached worker: only a memory note starts
// one, the hook itself opens no store, and the worker lands the rows and logs them.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { claudeFolderName } from '../../src/domain/agent-memories/claude-code.js';
import { note } from '../_helpers/agent-memories-world.js';
import { HIPPO_BIN } from '../_helpers/hippo-bin.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { waitFor } from '../_helpers/wait-for.js';

// Records the databases a run opens and the argv of each child it spawns; STUB_SPAWN=1 starts no child at all.
const PRELOAD_SRC = `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const opens = new Set();
const spawns = [];
const seen = new WeakSet();
for (const method of ['exec', 'prepare']) {
  const original = DatabaseSync.prototype[method];
  DatabaseSync.prototype[method] = function (...args) {
    if (!seen.has(this)) {
      seen.add(this);
      opens.add(this.location());
    }
    return original.apply(this, args);
  };
}
const realSpawn = cp.spawn;
cp.spawn = (cmd, args, ...rest) => {
  spawns.push(args);
  return process.env.STUB_SPAWN ? { on() {}, unref() {} } : realSpawn(cmd, args, ...rest);
};
syncBuiltinESMExports();
process.on('exit', () => writeFileSync(process.env.RECORD_FILE, JSON.stringify({ opens: [...opens], spawns })));
`;

const QUEUE_NOTE = 'The session folder note says the queue drains at midnight.';

let tmp: string;
let home: string;
let project: string;
let local: string;
let memoryDir: string;
let transcript: string;
let preload: string;
let record: string;
let logFile: string;

interface HookRun {
  readonly result: SpawnSyncReturns<string>;
  /** Databases the process opened. */
  readonly opens: string[];
  /** Argv of each child it spawned. */
  readonly spawns: string[][];
}

function runHippo(args: string[], input: string, env: Record<string, string> = {}, cwd = project): HookRun {
  fs.rmSync(record, { force: true });
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--import', pathToFileURL(preload).href, HIPPO_BIN, ...args],
    {
      cwd,
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HIPPO_HOME: path.join(tmp, 'global'),
        RECORD_FILE: record,
        ...env,
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  // SAFETY: the preload writes this file as one JSON object with the two lists.
  const seen = JSON.parse(fs.readFileSync(record, 'utf8')) as { opens: string[]; spawns: string[][] };
  return { result, ...seen };
}

const payload = (file: string): string =>
  JSON.stringify({
    session_id: 's1',
    transcript_path: transcript,
    cwd: project,
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: file, content: 'x' },
  });

const noteHook = (file: string, env: Record<string, string> = {}): HookRun =>
  runHippo(['note-written', '--log-file', logFile], payload(file), env);

const workers = (run: HookRun): string[][] => run.spawns.filter((argv) => argv.includes('__note-import-worker'));

const importedRows = (): string[] =>
  loadAllEntries(local, 'default')
    .filter((e) => e.source.startsWith('agent-memory:'))
    .map((e) => e.content);

const logText = (): string => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');

beforeEach(() => {
  tmp = fs.realpathSync.native(makeRoot('note-import-worker', { init: false }));
  home = path.join(tmp, 'home');
  project = path.join(tmp, 'proj');
  local = path.join(project, '.hippo');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  initTestStore(local);
  const session = path.join(home, '.claude', 'projects', claudeFolderName(project));
  memoryDir = path.join(session, 'memory');
  note(memoryDir, 'queue.md', QUEUE_NOTE);
  transcript = path.join(session, 's1.jsonl');
  fs.writeFileSync(transcript, '', 'utf8');
  preload = path.join(tmp, 'record-preload.mjs');
  fs.writeFileSync(preload, PRELOAD_SRC);
  record = path.join(tmp, 'record.json');
  logFile = path.join(tmp, 'logs', 'note-written.log');
});

describe('hippo note-written', () => {
  it.each([
    ['a source file', () => path.join(project, 'src', 'plan.md')],
    ['the MEMORY.md index', () => path.join(memoryDir, 'MEMORY.md')],
    ['a note in a folder under memory', () => path.join(memoryDir, 'sub', 'queue.md')],
    ['a file in the memory folder that is not markdown', () => path.join(memoryDir, 'queue.txt')],
    ['a note under another config folder', () => path.join(tmp, 'other', 'projects', 'p', 'memory', 'a.md')],
  ])('exits 0 for %s, opening no store and starting no worker', (_name, file) => {
    const run = noteHook(file());
    expect(run.opens).toEqual([]);
    expect(workers(run)).toEqual([]);
    expect(logText()).toBe('');
  });

  it('exits 0 for a payload that is not JSON, or has no file path, and opens no store', () => {
    for (const input of ['not json', '', JSON.stringify({ transcript_path: transcript, tool_input: {} })]) {
      const run = runHippo(['note-written', '--log-file', logFile], input);
      expect([run.opens, workers(run)]).toEqual([[], []]);
    }
  });

  it('starts one worker for a memory note, opens no store itself, and the note lands as a row with a log line', async () => {
    const run = noteHook(path.join(memoryDir, 'queue.md'));
    expect(run.opens).toEqual([]);
    expect(workers(run)).toHaveLength(1);
    await waitFor(() => importedRows().length === 1 && logText().includes('Imported 1 agent memory'), {
      timeoutMs: 20_000,
      what: 'the worker imports the note and logs it',
      retryOnThrow: true,
    });
    expect(importedRows()).toEqual([QUEUE_NOTE]);
    expect(logText()).toMatch(/^\[hippo\] \S+Z note-written: Imported 1 agent memory \(Claude Code 1\)\.\n$/);
  });

  it('reads the Claude Code folder from CLAUDE_CONFIG_DIR, so a note in the home folder no longer counts', () => {
    const config = path.join(tmp, 'config');
    const moved = path.join(config, 'projects', claudeFolderName(project), 'memory');
    note(moved, 'queue.md', QUEUE_NOTE);
    const env = { CLAUDE_CONFIG_DIR: config, STUB_SPAWN: '1' };
    expect(workers(noteHook(path.join(moved, 'queue.md'), env))).toHaveLength(1);
    expect(workers(noteHook(path.join(memoryDir, 'queue.md'), env))).toEqual([]);
  });
});

describe('the detached worker', () => {
  it('creates no store when none exists, and still exits 0', () => {
    const bare = path.join(tmp, 'bare');
    fs.mkdirSync(bare);
    runHippo(['__note-import-worker', '--transcript', transcript, '--log-file', logFile], '', {}, bare);
    expect(fs.existsSync(path.join(bare, '.hippo'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'global'))).toBe(false);
    expect(logText()).toBe('');
  });
});

describe('hippo post-compact', () => {
  const compactPayload = (): string =>
    JSON.stringify({ session_id: 's1', transcript_path: transcript, cwd: project, trigger: 'auto' });
  const compactLog = (): string => path.join(tmp, 'logs', 'pre-compact.log');

  it('hands the notes to a worker and imports none itself', () => {
    const run = runHippo(['post-compact', '--log-file', compactLog()], compactPayload(), { STUB_SPAWN: '1' });
    expect(workers(run)).toHaveLength(1);
    expect(run.spawns.flat()).toContain('post-compact');
    expect(importedRows()).toEqual([]);
  });

  it('lands the notes through that worker, which logs under the post-compact name', async () => {
    runHippo(['post-compact', '--log-file', compactLog()], compactPayload());
    await waitFor(() => importedRows().length === 1, {
      timeoutMs: 20_000,
      what: 'the worker imports the session folder',
      retryOnThrow: true,
    });
    await waitFor(() => fs.existsSync(compactLog()) && fs.readFileSync(compactLog(), 'utf8').includes('post-compact: Imported 1 agent memory'), {
      timeoutMs: 20_000,
      what: 'the worker logs the import',
    });
    expect(importedRows()).toEqual([QUEUE_NOTE]);
  });
});
