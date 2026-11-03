// A person's reply to the agent's work is their rule even with no rule word; the session's opening request is not.
// Real SQLite stores in tmp dirs, no mocks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from '../../src/surface/capture/command.js';
import { extractFromTexts } from '../../src/surface/capture/extract.js';
import { collectSessionTurns, type SessionTurn } from '../../src/surface/capture/transcript.js';
import { USER_RULE_TAG } from '../../src/base/memory/entry.js';
import { supersede } from '../../src/api/memories/promote.js';
import { ctxFor } from '../_helpers/query-count-seeds.js';
import { captureTarget } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { shareRoot } from '../_helpers/share-root.js';

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

  it('a reply the rule patterns catch is a user rule too', async () => {
    await capture([user(REQUEST), done, user('No: Never commit directly to `main`. Please fix it.')]);
    expect(rows().map((e) => [e.content, e.pinned, e.tags.includes(USER_RULE_TAG)])).toEqual([
      ['No: Never commit directly to `main`', true, true],
    ]);
  });

  it('a reply the preference patterns catch is a user rule when it names code or limits a choice', async () => {
    await capture([
      user(REQUEST),
      done,
      user('Use `pnpm` instead of `npm`.'),
      done,
      user('Avoid edits to `generated.ts`.'),
      done,
      user('I prefer small commits that each do one thing.'),
    ]);
    const stored = rows().sort((a, b) => a.content.localeCompare(b.content));
    expect(stored.map((e) => [e.content, e.pinned, e.tags.includes(USER_RULE_TAG)])).toEqual([
      ['Avoid edits to `generated.ts`', true, true],
      ['I prefer small commits that each do one thing', false, false],
      ['Use `pnpm` instead of `npm`', true, true],
    ]);
  });

  it('pins no praise or pasted output that names code, and keeps a thanks that goes on to direct', async () => {
    await capture([
      user(REQUEST),
      done,
      user('Thanks, `src/cache.ts` looks good.'),
      done,
      user('Great work on `fetchJson()`.'),
      done,
      user('src/cache.ts:42 expected 1 to equal 2'),
      done,
      user('Thanks, but run `pnpm test:unit`, not the bare `pnpm test`.'),
      done,
      user('Thanks, keep using `pnpm` for all installs.'),
      done,
      user('Use the existing helper in `src/cache.ts:42` rather than duplicating it.'),
    ]);
    const stored = rows().sort((a, b) => a.content.localeCompare(b.content));
    expect(stored.map((e) => [e.content, e.pinned])).toEqual([
      ['Thanks, but run `pnpm test:unit`, not the bare `pnpm test`', true],
      ['Thanks, keep using `pnpm` for all installs', true],
      ['Use the existing helper in `src/cache.ts:42` rather than duplicating it', true],
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

  const PREF = 'Use `pnpm` instead of `npm`.';
  const live = () =>
    rows()
      .filter((e) => e.supersededBy === null)
      .map((e) => [e.content, e.pinned, e.tags.includes(USER_RULE_TAG)]);

  it('a reply that repeats the opening preference stores the rule, not the plain preference', async () => {
    await capture([user(PREF), done, user(PREF)]);
    expect(live()).toEqual([['Use `pnpm` instead of `npm`', true, true]]);
  });

  it('a later turn capture that repeats a stored preference replaces that row with the rule', async () => {
    await capture([user(PREF), done]);
    expect(live()).toEqual([['Use `pnpm` instead of `npm`', false, false]]);
    await capture([user(PREF), done], false);
    expect(live()).toEqual([['Use `pnpm` instead of `npm`', true, true]]);
    const [rule] = rows().filter((e) => e.pinned);
    expect(
      rows()
        .filter((e) => !e.pinned)
        .map((e) => e.supersededBy),
    ).toEqual([rule.id]);
  });

  it('a replayed reply revives no preference that was already superseded', async () => {
    await capture([user(PREF), done]);
    const [old] = rows();
    await supersede(ctxFor(root), old.id, 'Use `pnpm` for every install.');
    await capture([user(PREF), done], false);
    expect(live()).toEqual([['Use `pnpm` for every install.', false, false]]);
  });

  it('a reply never replaces a correction made with hippo supersede', async () => {
    const fixed = 'Use `pnpm` instead of `npm` for installs';
    await capture([user(PREF), done]);
    const [old] = rows();
    await supersede(ctxFor(root), old.id, fixed);
    await capture([user(`${fixed}.`), done], false);
    expect(
      rows()
        .filter((e) => e.supersededBy === null)
        .map((e) => [e.content, e.confidence]),
    ).toEqual([[fixed, 'verified']]);
  });

  // A shared store stamps a capture with no project as no project, which no project context shows.
  const sharedCapture = (originProject?: { name: string; legacyName: string; aliases?: string[] }) =>
    runCapture(captureTarget(root), {
      tenantId: 'default',
      source: 'last-session',
      sessionTurns: [user(PREF), done],
      fromStart: false,
      dryRun: false,
      global: false,
      originProject,
    });

  // The opening request stores the plain preference, so a later reply is the rule.
  const sharedRequest = (originProject: { name: string; legacyName: string }) =>
    runCapture(captureTarget(root), {
      tenantId: 'default',
      source: 'last-session',
      sessionTurns: [user(PREF), done],
      dryRun: false,
      global: false,
      originProject,
    });

  it('in a shared store, a rule with no project never replaces a project row', async () => {
    shareRoot(root);
    await sharedRequest({ name: 'acme-web', legacyName: 'acme-web' });
    await sharedCapture();
    expect(rows().map((e) => [e.originProject, e.pinned, e.supersededBy])).toEqual([['acme-web', false, null]]);
  });

  it('in a shared store, a rule replaces the row its project stored under an older name', async () => {
    shareRoot(root);
    await sharedRequest({ name: 'acme-web-old', legacyName: 'acme-web-old' });
    await sharedCapture({ name: 'acme-web', legacyName: 'acme-web', aliases: ['acme-web-old'] });
    expect(live()).toEqual([['Use `pnpm` instead of `npm`', true, true]]);
    expect(
      rows()
        .filter((e) => e.supersededBy === null)
        .map((e) => e.originProject),
    ).toEqual(['acme-web']);
  });

  it('in a shared store, a rule never replaces a row of another project', async () => {
    shareRoot(root);
    await sharedRequest({ name: 'billing', legacyName: 'billing' });
    await sharedCapture({ name: 'acme-web', legacyName: 'acme-web' });
    expect(
      rows()
        .filter((e) => e.supersededBy === null)
        .map((e) => [e.originProject, e.pinned])
        .sort(),
    ).toEqual([
      ['acme-web', true],
      ['billing', false],
    ]);
  });

  it('a rule repeated in a later turn capture stays one row', async () => {
    await capture([done, user(PREF)], false);
    await capture([done, user(PREF)], false);
    expect(rows().map((e) => [e.content, e.pinned])).toEqual([['Use `pnpm` instead of `npm`', true]]);
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

describe('which replies capture reads as a rule', () => {
  const ruleFromReply = (reply: string): boolean =>
    extractFromTexts([REQUEST, reply], 2, 1).some((i) => i.tags.includes('follow-up'));

  it.each([
    'Thanks, keep using `pnpm` for all installs.',
    'Thanks, but run `pnpm test:unit`, not the bare `pnpm test`.',
    'Use the existing helper in `src/cache.ts:42` rather than duplicating it.',
    'Keep button styles in `shared.css` so all dialogs look right.',
    'Use `pnpm` instead of `npm`.',
    'Avoid edits to `generated.ts`.',
    REPLY,
  ])('keeps %s', (reply) => {
    expect(ruleFromReply(reply)).toBe(true);
  });

  it.each([
    'Thanks, `src/cache.ts` looks good.',
    'Thanks for the great work on `src/cache.ts`.',
    'Great work on `fetchJson()`.',
    '`src/cache.ts` works now.',
    'src/cache.ts:42 expected 1 to equal 2',
    '--> src/cache.rs:42:3',
    '#0 fetchJson () at src/cache.cpp:42',
    'TypeError: fetchJson is not a function',
    'Tests 3 failed | 120 passed (123)',
  ])('drops %s', (reply) => {
    expect(ruleFromReply(reply)).toBe(false);
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
