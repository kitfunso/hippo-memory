// Capture calls the model only for a whole capture with capture.followUpRules on and a key set.
// Real CLI verbs and stores in this process; fetch is stubbed, so nothing leaves the machine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const RULE_SENTENCE =
  "No: Clean build: `./mvnw clean package -DskipTests --batch-mode`, because the project's maintainers require it";

let dir: string;
let cwd: string;
let globalRoot: string;
let transcript: string;
let modelCalls: number;

function writeConfig(followUpRules: string, root = globalRoot): void {
  const config = { capture: { followUpRules }, embeddings: { enabled: false } };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
}

function envWith(key: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: globalRoot, HOME: dir, USERPROFILE: dir };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.HIPPO_SESSION_ID;
  if (key === null) delete env.ANTHROPIC_API_KEY;
  else env.ANTHROPIC_API_KEY = key;
  return env;
}

function sessionEnd(extra: string[], key: string | null = 'test-key') {
  const args = ['__session-end-worker', '--transcript', transcript, '--session-id', 'sess-follow-up', ...extra];
  return runCliAs([...args, '--log-file', path.join(dir, 'session-end.log')], { cwd, env: envWith(key) });
}

beforeEach(() => {
  dir = makeRoot('follow-up-switch', { init: false });
  cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  globalRoot = path.join(dir, 'global');
  initTestStore(globalRoot);
  transcript = path.join(dir, 'session.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Please add ctx.disableCompression() to the Context.' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added it.' }] } },
    { type: 'user', message: { role: 'user', content: `${RULE_SENTENCE}. Please fix it.` } },
  ];
  fs.writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  modelCalls = 0;
  const reply = { content: [{ type: 'text', text: '[{"i": 0, "s": [0]}]' }] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      if (String(input instanceof Request ? input.url : input).includes('api.anthropic.com')) modelCalls++;
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const contents = (): string[] => loadAllEntries(globalRoot, 'default').map((entry) => entry.content);

describe('capture.followUpRules', () => {
  it('a session end with the switch on and a key asks the model once and stores its pick', async () => {
    writeConfig('model');
    expect((await sessionEnd([])).status).toBe(0);
    expect(modelCalls).toBe(1);
    expect(contents()).toEqual([RULE_SENTENCE]);
  });

  it('hippo capture --last-session takes the same path in a project store', async () => {
    const projectRoot = path.join(cwd, '.hippo');
    initTestStore(projectRoot);
    writeConfig('model', projectRoot);
    const result = await runCliAs(['capture', '--last-session', '--transcript', transcript], {
      cwd,
      env: envWith('test-key'),
    });
    expect(result.status).toBe(0);
    expect(modelCalls).toBe(1);
    expect(loadAllEntries(projectRoot, 'default').map((entry) => entry.content)).toEqual([RULE_SENTENCE]);
  });

  it('hippo capture --global names no project, so it never asks the model', async () => {
    writeConfig('model');
    const args = ['capture', '--last-session', '--transcript', transcript, '--global'];
    expect((await runCliAs(args, { cwd, env: envWith('test-key') })).status).toBe(0);
    expect(modelCalls).toBe(0);
  });

  it('a per-reply capture never asks the model', async () => {
    writeConfig('model');
    expect((await sessionEnd(['--turn'])).status).toBe(0);
    expect(modelCalls).toBe(0);
  });

  it('the switch off never asks the model', async () => {
    writeConfig('off');
    expect((await sessionEnd([])).status).toBe(0);
    expect(modelCalls).toBe(0);
  });

  it('no key never asks the model, and says why', async () => {
    writeConfig('model');
    const result = await sessionEnd([], null);
    expect(result.status).toBe(0);
    expect(modelCalls).toBe(0);
    expect(result.stderr).toContain('ANTHROPIC_API_KEY is not set');
  });
});
