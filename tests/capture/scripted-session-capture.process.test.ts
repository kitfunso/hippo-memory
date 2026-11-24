import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { loadAllEntries } from '../_helpers/root-forms.js';

const TAUGHT =
  'No: never edit CHANGELOG.md by hand, because the release script builds CHANGELOG.md from changelog.d. Please fix it.';

let dir: string;
let cwd: string;
let local: string;
let transcript: string;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    HIPPO_HOME: path.join(dir, 'global'),
    HOME: dir,
    USERPROFILE: dir,
    ...extra,
  };
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.HIPPO_SESSION_ID;
  if (extra.HIPPO_CAPTURE_SCRIPTED === undefined) delete e.HIPPO_CAPTURE_SCRIPTED;
  return e;
}

async function endSession(extra: NodeJS.ProcessEnv = {}): Promise<void> {
  const args = ['__session-end-worker', '--transcript', transcript, '--session-id', 'sess-scripted'];
  const result = await runCliAs([...args, '--log-file', path.join(dir, 'end.log')], { cwd, env: env(extra) });
  expect(result.status).toBe(0);
}

const pinned = () =>
  loadAllEntries(local, 'default')
    .filter((e) => e.pinned)
    .map((e) => e.content);

beforeEach(() => {
  dir = makeRoot('scripted-session-capture', { init: false });
  cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  initTestStore(path.join(dir, 'global'));
  local = path.join(cwd, '.hippo');
  initTestStore(local);
  fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
  transcript = path.join(dir, 'session.jsonl');
  const line = (type: 'user' | 'assistant', content: string | readonly { type: 'text'; text: string }[]) =>
    JSON.stringify({ type, entrypoint: 'sdk-cli', promptSource: 'sdk', message: { role: type, content } });
  const lines = [
    line('user', 'Add a release note for the retry fix.'),
    line('assistant', [{ type: 'text', text: 'Added it to CHANGELOG.md.' }]),
    line('user', TAUGHT),
  ];
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
});

describe('session-end on a scripted session', () => {
  it('pins nothing from the prompts a program sent', async () => {
    await endSession();
    expect(pinned()).toEqual([]);
  });

  it('pins the rule when the harness says it plays the person', async () => {
    await endSession({ HIPPO_CAPTURE_SCRIPTED: '1' });
    expect(pinned()).toEqual([expect.stringContaining('never edit CHANGELOG.md by hand')]);
  });
});
