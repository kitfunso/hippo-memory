// A person's reply to the agent's work is their rule even with no rule word; the session's opening request is not.
// Real SQLite stores in tmp dirs, no mocks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from '../../src/surface/capture/command.js';
import { extractFromTexts } from '../../src/surface/capture/extract.js';
import { collectSessionTurns, type SessionTurn } from '../../src/surface/capture/transcript.js';
import { USER_RULE_TAG } from '../../src/base/memory/entry.js';
import { captureTarget } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const REQUEST = 'Add a retry with backoff to fetchJson in src/net.ts.';
const REPLY =
  'Run the tests with `pnpm test:unit`, not the bare `pnpm test`: the bare one also starts the browser suite.';
const SHORT = 'Thanks, looks good.';

describe('capture keeps the rules a person gives in reply', () => {
  let scratch: string;
  let root: string;

  const capture = (turns: SessionTurn[], fromStart?: boolean) =>
    runCapture(captureTarget(root), {
      tenantId: 'default',
      source: 'last-session',
      sessionTurns: turns,
      fromStart,
      dryRun: false,
      global: false,
    });
  const rows = () => loadAllEntries(root, 'default');
  const user = (text: string): SessionTurn => ({ role: 'user', text });
  const done: SessionTurn = { role: 'assistant', text: 'Added the retry and its test.' };

  beforeEach(() => {
    scratch = makeRoot('reply-rules', { init: false });
    root = join(scratch, 'project', '.hippo');
    initTestStore(root);
    const global = join(scratch, 'global');
    initTestStore(global);
    vi.stubEnv('HIPPO_HOME', global);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('pins a reply with no rule word as a user rule, and leaves the request and a thanks out', async () => {
    await capture([user(REQUEST), done, user(REPLY), done, user(SHORT)]);
    expect(rows().map((e) => [e.content, e.pinned, e.tags.includes(USER_RULE_TAG)])).toEqual([
      [expect.stringContaining('pnpm test:unit'), true, true],
    ]);
  });

  it('a session with only its request captures nothing', async () => {
    await capture([user(REQUEST), done]);
    expect(rows()).toEqual([]);
  });

  it('pins no reply that names no code and limits no choice', async () => {
    const noise = [
      'Thanks, that looks good to me.',
      'Now do the same for the other file.',
      'Tests 3 failed | 120 passed (123)',
    ];
    await capture([user(REQUEST), ...noise.flatMap((n) => [done, user(n)]), done, user(REPLY)]);
    expect(rows().map((e) => e.content)).toEqual([expect.stringContaining('pnpm test:unit')]);
  });

  it('pins a short reply that names code, and leaves a short limit with no code out', async () => {
    await capture([user(REQUEST), done, user('`pnpm` for installs.'), done, user('Not that.')]);
    expect(rows().map((e) => [e.content, e.pinned])).toEqual([['`pnpm` for installs', true]]);
  });

  const replies = (n: number) =>
    Array.from({ length: n }, (_, i) => user(`Name the helper file net-${i}.ts in the same folder as the caller.`));

  it('a tail that cut off the request reads its first user turn as a reply', async () => {
    await capture([user(REQUEST), ...replies(20)]);
    expect(rows().filter((e) => e.pinned)).toHaveLength(20);
  });

  it('a tail of exactly 20 user turns still holds the request, so the request stays out', async () => {
    await capture([user(REQUEST), ...replies(19)]);
    const contents = rows().map((e) => e.content);
    expect(contents).toHaveLength(19);
    expect(contents.some((c) => c.includes('fetchJson'))).toBe(false);
  });

  it('a later turn slice reads its first user turn as a reply; a slice from the start does not', async () => {
    await capture([done, user(REPLY)], false);
    expect(rows().map((e) => [e.content, e.pinned])).toEqual([[expect.stringContaining('pnpm test:unit'), true]]);
    rmSync(root, { recursive: true, force: true });
    initTestStore(root);
    await capture([user(REPLY), done]);
    expect(rows()).toEqual([]);
  });

  it('a reply the patterns already place keeps their category; the agent never gets the reply rule', () => {
    const items = extractFromTexts(["Let's go with SQLite for the cache.", REPLY, REPLY], 2, 1);
    expect(items.map((i) => [i.category, i.fromUser])).toEqual([
      ['decision', true],
      ['rule', true],
    ]);
    expect(extractFromTexts([REQUEST, REPLY], 0, 0)).toEqual([]);
    const agent = 'Run the suite with `pnpm test:e2e` before the merge.';
    expect(extractFromTexts([REPLY, agent], 1, 0).map((i) => [i.content, i.fromUser])).toEqual([
      [expect.stringContaining('pnpm test:unit'), true],
    ]);
  });
});

describe('the transcript reader keeps only what a person typed', () => {
  it('drops the user lines Claude Code writes for ! shell commands and task notices', () => {
    const userLine = (content: string) => ({ type: 'user', message: { role: 'user', content } });
    const lines = [
      userLine(REQUEST),
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Added the retry.' }] },
      },
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
