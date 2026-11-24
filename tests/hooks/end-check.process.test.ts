import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { END_CHECK_LEAD } from '../../src/api/end-check.js';
import { USER_RULE_TAG } from '../../src/api/context/user-rule.js';
import { detectorTags } from '../../src/base/memory/detect-tags.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { initTestStore } from '../_helpers/store-template.js';

const PROJECT = 'work';
const RULE = 'No: Run `npm test` before you finish, because CI runs it.';
const FINAL = 'Fixed the parser.';

let dir: string;
let cwd: string;
let local: string;
let globalRoot: string;
let transcript: string;

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: globalRoot, HOME: dir, USERPROFILE: dir };
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.HIPPO_SESSION_ID;
  return e;
}

function ruleRow(): MemoryEntry {
  const tags = detectorTags({ applies: ['**/*.ts'], commands: [['npm test', 'npm run test']] });
  const row = createMemory(RULE, {
    source: 'capture',
    confidence: 'observed',
    pinned: true,
    tags: ['rule', 'captured', USER_RULE_TAG, ...tags],
  });
  return { ...row, originProject: PROJECT };
}

const prompt = (text: string) => ({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: text } });
const said = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const call = <T>(id: string, name: string, input: T) => [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
];
const editRows = () => [
  prompt('fix the parser'),
  ...call('e1', 'Edit', { file_path: path.join(cwd, 'src', 'parse.ts') }),
];
const stopListing = (text: string) => ({
  type: 'attachment',
  attachment: { type: 'hook_additional_context', content: [text], hookName: 'Stop', hookEvent: 'Stop' },
});

function writeTranscript<T>(rows: readonly T[]): void {
  fs.writeFileSync(transcript, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

interface StopOverrides {
  readonly stop_hook_active?: boolean;
  readonly background_tasks?: readonly { readonly id: string }[];
  readonly session_crons?: readonly { readonly id: string }[];
}

function stopPayload(over: StopOverrides = {}): string {
  return JSON.stringify({
    session_id: 's1',
    transcript_path: transcript,
    cwd,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: FINAL,
    background_tasks: [],
    session_crons: [],
    ...over,
  });
}

async function endCheck(over: StopOverrides = {}): Promise<{ status: number; stdout: string }> {
  const { status, stdout, stderr } = await runCliAs(['end-check'], { cwd, env: env(), input: stopPayload(over) });
  expect(stderr).toBe('');
  return { status, stdout };
}

const silent = { status: 0, stdout: '' };

beforeEach(() => {
  dir = makeRoot('end-check', { init: false });
  cwd = path.join(dir, PROJECT);
  fs.mkdirSync(cwd);
  local = path.join(cwd, '.hippo');
  globalRoot = path.join(dir, 'global');
  transcript = path.join(dir, 's1.jsonl');
  initTestStore(globalRoot);
  initTestStore(local);
  writeEntry(local, ruleRow());
});

describe('hippo end-check', () => {
  it('lists an open rule as Stop additional context', async () => {
    writeTranscript([...editRows(), said(FINAL)]);

    const { status, stdout } = await endCheck();

    expect(status).toBe(0);
    const reply = JSON.parse(stdout);
    expect(reply.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(reply.hookSpecificOutput.additionalContext.startsWith(END_CHECK_LEAD)).toBe(true);
    expect(reply.hookSpecificOutput.additionalContext).toContain(`1. ${RULE}`);
  });

  it('lists with pinned injection off, which only gates the prompt blocks', async () => {
    fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({ pinnedInject: { enabled: false } }));
    writeTranscript([...editRows(), said(FINAL)]);

    expect((await endCheck()).stdout).toContain(RULE);
  });

  it('prints nothing for a rule an earlier Stop in the session listed', async () => {
    writeTranscript([...editRows(), said('Done.'), stopListing(`${END_CHECK_LEAD}\n\n1. ${RULE}`), said(FINAL)]);

    expect(await endCheck()).toEqual(silent);
  });

  it('prints nothing on the Stop that follows its own listing, or while the session is paused', async () => {
    writeTranscript([...editRows(), said(FINAL)]);

    expect(await endCheck({ stop_hook_active: true })).toEqual(silent);
    expect(await endCheck({ background_tasks: [{ id: 'b1' }] })).toEqual(silent);
    expect(await endCheck({ session_crons: [{ id: 'c1' }] })).toEqual(silent);
  });

  it('prints nothing with no edit since the last prompt', async () => {
    writeTranscript([...editRows(), said('Done.'), prompt('thanks'), said(FINAL)]);

    expect(await endCheck()).toEqual(silent);
  });

  it('prints nothing once one of the rule commands ran', async () => {
    writeTranscript([...editRows(), ...call('b1', 'Bash', { command: 'cd work && npm run test' }), said(FINAL)]);

    expect(await endCheck()).toEqual(silent);
  });

  it('prints nothing in a pilot holdout session', async () => {
    fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({ pilot: { holdoutRateBp: 10_000 } }));
    writeTranscript([...editRows(), said(FINAL)]);

    expect(await endCheck()).toEqual(silent);
  });

  it('prints nothing and creates no store when no store exists', async () => {
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(globalRoot, { recursive: true, force: true });
    writeTranscript([...editRows(), said(FINAL)]);

    expect(await endCheck()).toEqual(silent);
    expect([fs.existsSync(local), fs.existsSync(globalRoot)]).toEqual([false, false]);
  });
});
