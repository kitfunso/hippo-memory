// A person's reply to the agent's work is their rule even with no rule word; the session's opening request is not.
// Real SQLite stores in tmp dirs, no mocks.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCapture } from '../src/capture/command.js';
import { extractFromTexts } from '../src/capture/extract.js';
import { collectSessionTurns } from '../src/capture/transcript.js';
import type { SessionTurn } from '../src/capture/transcript.js';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';

const REQUEST = 'Add a retry with backoff to fetchJson in src/net.ts.';
const REPLY = 'Run the tests with `pnpm test:unit`, not the bare `pnpm test`: the bare one also starts the browser suite.';
const SHORT = 'Thanks, looks good.';

describe('capture keeps the rules a person gives in reply', () => {
  let scratch: string;
  let root: string;
  let priorHome: string | undefined;

  const capture = (turns: SessionTurn[], fromStart?: boolean) =>
    cmdCapture(root, { source: 'last-session', sessionTurns: turns, fromStart, dryRun: false, global: false });
  const user = (text: string): SessionTurn => ({ role: 'user', text });
  const done: SessionTurn = { role: 'assistant', text: 'Added the retry and its test.' };

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hippo-follow-up-rules-'));
    root = join(scratch, 'project', '.hippo');
    initStore(root);
    const global = join(scratch, 'global');
    initStore(global);
    priorHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = global;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = priorHome;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('pins a reply with no rule word and leaves the request and a short thanks out', () => {
    capture([user(REQUEST), done, user(REPLY), done, user(SHORT)]);
    expect(loadAllEntries(root).map((e) => [e.content, e.pinned])).toEqual([[expect.stringContaining('pnpm test:unit'), true]]);
  });

  it('a session with only its request captures nothing new', () => {
    capture([user(REQUEST), done]);
    expect(loadAllEntries(root)).toEqual([]);
  });

  it('pins no reply that names no code and limits no choice: a long thanks, "do the same", a pasted test count', () => {
    const noise = ['Thanks, that looks good to me.', 'Now do the same for the other file.', 'Tests 3 failed | 120 passed (123)'];
    capture([user(REQUEST), ...noise.flatMap((n) => [done, user(n)]), done, user(REPLY)]);
    expect(loadAllEntries(root).map((e) => e.content)).toEqual([expect.stringContaining('pnpm test:unit')]);
  });

  it('pins a short reply that names code, and leaves a short limit with no code out', () => {
    capture([user(REQUEST), done, user('`pnpm` for installs.'), done, user('Not that.')]);
    expect(loadAllEntries(root).map((e) => [e.content, e.pinned])).toEqual([['`pnpm` for installs', true]]);
  });

  const replies = (n: number) => Array.from({ length: n }, (_, i) => user(`Name the helper file net-${i}.ts in the same folder as the caller.`));

  it('a tail that cut off the request reads its first user turn as a reply', () => {
    capture([user(REQUEST), ...replies(20)]);
    expect(loadAllEntries(root).filter((e) => e.pinned)).toHaveLength(20);
  });

  it('a tail of exactly 20 user turns still holds the request, so the request stays out', () => {
    capture([user(REQUEST), ...replies(19)]);
    const contents = loadAllEntries(root).map((e) => e.content);
    expect(contents).toHaveLength(19);
    expect(contents.some((c) => c.includes('fetchJson'))).toBe(false);
  });

  it('a later --turn slice reads its first user turn as a reply, and a slice from the start does not', () => {
    capture([done, user(REPLY)], false);
    expect(loadAllEntries(root).map((e) => [e.content, e.pinned])).toEqual([[expect.stringContaining('pnpm test:unit'), true]]);
    rmSync(root, { recursive: true, force: true });
    initStore(root);
    capture([user(REPLY), done]);
    expect(loadAllEntries(root)).toEqual([]);
  });

  it('a reply the patterns already place keeps their category, and the agent never gets the reply rule', () => {
    const items = extractFromTexts(["Let's go with SQLite for the cache.", REPLY, REPLY], 2, 1);
    expect(items.map((i) => [i.category, i.fromUser])).toEqual([['decision', true], ['rule', true]]);
    expect(extractFromTexts([REQUEST, REPLY], 0, 0)).toEqual([]);
    const agent = 'Run the suite with `pnpm test:e2e` before the merge.';
    expect(extractFromTexts([REPLY, agent], 1, 0).map((i) => [i.content, i.fromUser])).toEqual([[expect.stringContaining('pnpm test:unit'), true]]);
  });
});

describe('the transcript reader keeps only what a person typed', () => {
  it('drops the user lines Claude Code writes for ! shell commands and task notices', () => {
    const userLine = (content: string) => ({ type: 'user', message: { role: 'user', content } });
    const lines = [
      userLine(REQUEST),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added the retry.' }] } },
      userLine('<bash-input>pnpm test</bash-input>'),
      userLine('<bash-stdout>Tests 3 failed | 120 passed (123)</bash-stdout>'),
      userLine('<bash-stderr>Error: the browser suite did not start</bash-stderr>'),
      userLine('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'),
      userLine(REPLY),
    ];
    const turns = collectSessionTurns(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(turns.filter((t) => t.role === 'user').map((t) => t.text)).toEqual([REQUEST, REPLY]);
  });
});
