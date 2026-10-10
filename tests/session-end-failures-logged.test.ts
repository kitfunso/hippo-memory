// End to end through bin/hippo.js: a session-end step that fails leaves a line in the session log and one warn line.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SpawnSyncReturns } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hippoRun } from './_helpers/spawn-hippo.js';

let tmp: string;
let repo: string;
let log: string;
let env: NodeJS.ProcessEnv;

const hippo = (args: readonly string[], input?: string): SpawnSyncReturns<string> => hippoRun(args, { cwd: repo, env, input });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-session-end-failures-'));
  repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  log = path.join(tmp, 'worker.log');
  const drop = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HIPPO_TENANT', 'HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID',
    'XDG_DATA_HOME', 'HIPPO_HOME', 'HOME', 'USERPROFILE', 'HIPPO_LOG', 'HIPPO_LOG_FORMAT']);
  env = {};
  for (const [key, value] of Object.entries(process.env)) if (!drop.has(key.toUpperCase())) env[key] = value;
  Object.assign(env, { HIPPO_HOME: path.join(tmp, 'global'), HOME: home, USERPROFILE: home, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' });
  expect(hippo(['init', '--no-hooks', '--no-schedule', '--no-learn']).status).toBe(0);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The lines of `text` that hold `needle`. */
const linesWith = (text: string, needle: string): string[] => text.split('\n').filter((line) => line.includes(needle));

describe('a session-end step that fails', () => {
  it('a Codex history file that cannot be read is named in the session log and at warn', () => {
    const codexHome = path.join(tmp, 'codex');
    const unreadable = path.join(codexHome, 'history.jsonl');
    // A folder where the history file should be: it exists, and reading it throws.
    fs.mkdirSync(unreadable, { recursive: true });

    const run = hippo(['__codex-session-end-worker', '--codex-home', codexHome, '--history-path', unreadable,
      '--started-at', '1', '--log-file', log]);

    expect(run.status).toBe(0);
    const failure = 'codex session-end: transcript scan or digest failed: ';
    const logged = linesWith(fs.readFileSync(log, 'utf8'), failure);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^\[hippo\] \d{4}-\d\d-\d\dT[\d:.]+Z codex session-end: transcript scan or digest failed: \S/);
    expect(linesWith(run.stderr, `[hippo] warn: ${failure}`)).toHaveLength(1);
  });

  it('a sleep that fails is named in the session log and at warn, and the later steps still run', () => {
    fs.writeFileSync(path.join(repo, '.hippo', 'hippo.db'), 'not a sqlite database');

    const run = hippo(['__session-end-worker', '--log-file', log], JSON.stringify({ hook_event_name: 'SessionEnd' }));

    expect(run.status).toBe(0);
    const text = fs.readFileSync(log, 'utf8');
    expect(linesWith(text, ' session-end: sleep failed: ')).toHaveLength(1);
    expect(linesWith(run.stderr, '[hippo] warn: session-end: sleep failed: ')).toHaveLength(1);
    expect(text.indexOf('skip: no session_id')).toBeGreaterThan(text.indexOf(' session-end: sleep failed: '));
  });
});
