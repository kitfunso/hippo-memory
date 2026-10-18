// A person's reply to the agent's work is their rule even with no rule word; the session's opening request is not.
// Real SQLite stores in tmp dirs, no mocks.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCapture } from '../src/capture/command.js';
import { extractFromTexts } from '../src/capture/extract.js';
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

  const capture = (turns: SessionTurn[]) => cmdCapture(root, { source: 'last-session', sessionTurns: turns, dryRun: false, global: false });
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

  it('a tail that cut off the request reads its first user turn as a reply', () => {
    const replies = Array.from({ length: 20 }, (_, i) => user(`Name the helper file net-${i}.ts in the same folder as the caller.`));
    capture([user(REQUEST), ...replies]);
    expect(loadAllEntries(root).filter((e) => e.pinned)).toHaveLength(20);
  });

  it('a reply the patterns already place keeps their category, and the agent never gets the reply rule', () => {
    const items = extractFromTexts(["Let's go with SQLite for the cache.", REPLY, REPLY], 2, 1);
    expect(items.map((i) => [i.category, i.fromUser])).toEqual([['decision', true], ['rule', true]]);
    expect(extractFromTexts([REQUEST, REPLY], 0, 0)).toEqual([]);
  });
});
