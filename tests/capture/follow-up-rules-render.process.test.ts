// End to end: a follow-up rule the model picks at session end prints first, as a plain
// instruction, in the next session's hook block. Real CLI verbs and stores; fetch is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { initGitRepo } from '../_helpers/churn-git-repo.js';

const RULE_SENTENCE =
  "No: Clean build: `./mvnw clean package -DskipTests --batch-mode`, because the project's maintainers require it";

let dir: string;
let cwd: string;
let globalRoot: string;
let transcript: string;

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: globalRoot, HOME: dir, USERPROFILE: dir };
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.HIPPO_SESSION_ID;
  e.ANTHROPIC_API_KEY = 'test-key';
  return e;
}

function writeConfig(root: string): void {
  const config = { capture: { followUpRules: 'model' }, embeddings: { enabled: false } };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
}

async function endSession(): Promise<void> {
  const args = ['__session-end-worker', '--transcript', transcript, '--session-id', 'sess-teach'];
  const result = await runCliAs([...args, '--log-file', path.join(dir, 'end.log')], { cwd, env: env() });
  expect(result.status).toBe(0);
}

async function nextHookBlock(): Promise<string> {
  const args = ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'];
  const result = await runCliAs(args, { cwd, env: env(), input: JSON.stringify({ session_id: 'sess-apply' }) });
  expect(result.status).toBe(0);
  return result.stdout;
}

beforeEach(() => {
  dir = makeRoot('follow-up-render', { init: false });
  cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  globalRoot = path.join(dir, 'global');
  initTestStore(globalRoot);
  writeConfig(globalRoot);
  transcript = path.join(dir, 'session.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Please add ctx.disableCompression() to the Context.' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added it.' }] } },
    { type: 'user', message: { role: 'user', content: `${RULE_SENTENCE}. Please fix it.` } },
  ];
  fs.writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const reply = { content: [{ type: 'text', text: '[{"i": 0, "s": [0]}]' }] };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a follow-up rule in the next session', () => {
  it('prints first as a plain instruction when the project has its own store', async () => {
    const local = path.join(cwd, '.hippo');
    initTestStore(local);
    writeConfig(local);
    await endSession();
    const block = await nextHookBlock();
    expect(block).toContain('## Rules from the user');
    expect(block).toContain(RULE_SENTENCE);
    expect(block).not.toContain('Previously observed');
  });

  it('asks no model when only the global store exists and the session has no project', async () => {
    await endSession();
    expect(fetch).not.toHaveBeenCalled();
    expect(await nextHookBlock()).not.toContain('## Rules from the user');
  });

  it('prints in the git project it was taught in, from the global store only', async () => {
    initGitRepo(cwd);
    await endSession();
    const block = await nextHookBlock();
    expect(block).toContain('## Rules from the user');
    expect(block).toContain(RULE_SENTENCE);
  });

  it('stays out of another git project that shares the global store', async () => {
    initGitRepo(cwd);
    await endSession();
    cwd = path.join(dir, 'other');
    fs.mkdirSync(cwd);
    initGitRepo(cwd);
    const block = await nextHookBlock();
    expect(block).not.toContain('## Rules from the user');
  });
});
