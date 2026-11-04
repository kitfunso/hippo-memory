// A person's reply is their rule only with a rule or preference word; other replies stay unpinned notes.
// Real SQLite stores in tmp dirs, no mocks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runCapture } from '../../src/surface/capture/command.js';
import { extractFromTexts } from '../../src/surface/capture/extract.js';
import { collectSessionTurns, type SessionTurn } from '../../src/surface/capture/transcript.js';
import { CAPTURED_NOTE_TAG, Layer, USER_RULE_TAG } from '../../src/base/memory/entry.js';
import { NO_MERGE_TAGS, neverAutoShareTags } from '../../src/domain/sharing/share.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { supersede } from '../../src/api/memories/promote.js';
import { ctxFor, memory, seed } from '../_helpers/query-count-seeds.js';
import { contextGet } from '../../src/api/index.js';
import { consolidate } from '../../src/index.js';
import { resolveProjectIdentity } from '../../src/host/project-identity.js';
import { captureTarget } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries, writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { shareRoot } from '../_helpers/share-root.js';

const REQUEST = 'Add a retry with backoff to fetchJson in src/net.ts.';
const REPLY =
  'Run the tests with `pnpm test:unit`, not the bare `pnpm test`: the bare one also starts the browser suite.';
const SHORT = 'Thanks, looks good.';

describe('capture keeps what a person says in reply', () => {
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

  it('keeps a reply with no rule word as a note, and leaves the request and a thanks out', async () => {
    await capture([user(REQUEST), done, user(REPLY), done, user(SHORT)]);
    expect(rows().map((e) => [e.content, e.pinned, e.tags.includes(USER_RULE_TAG)])).toEqual([
      [expect.stringContaining('pnpm test:unit'), false, false],
    ]);
  });

  it.each([
    "Don't worry about it.",
    'stop, delete everything related to this project.',
    'continue dude, submit if you need. do not hold back.',
    'check https://example.com/page for me.',
  ])('never pins the one-off reply %s', async (reply) => {
    await capture([user(REQUEST), done, user(reply)]);
    expect(rows().filter((e) => e.pinned || e.tags.includes(USER_RULE_TAG))).toEqual([]);
  });

  it.each([
    [
      'closed',
      'Old runbook:\n<pasted_content id="1">Always deploy on Fridays. Never run the tests first.</pasted_content>',
    ],
    ['never closed', 'Old runbook:\n<pasted_content id="1">Always deploy on Fridays. Never run the tests first.'],
  ])('keeps a pasted block out of the rules, %s', async (_name, turn) => {
    await capture([user(REQUEST), done, user(turn)]);
    expect(rows().filter((e) => /deploy|tests first|pasted_content/.test(e.content))).toEqual([]);
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

  it('keeps no praise or pasted output that names code, and keeps a thanks that goes on to direct as a note', async () => {
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
      ['Thanks, but run `pnpm test:unit`, not the bare `pnpm test`', false],
      ['Thanks, keep using `pnpm` for all installs', false],
      ['Use the existing helper in `src/cache.ts:42` rather than duplicating it', false],
    ]);
  });

  it('a captured note stays out of the recent list; a decision does not', async () => {
    await capture([user(REQUEST), done, user(REPLY), done, user("Let's go with SQLite for the cache.")]);
    const { entries } = await contextGet(ctxFor(root), {
      currentProject: resolveProjectIdentity(dirname(root)),
      pinnedOnly: true,
      includeRecent: 5,
      budget: 500,
    });
    expect(entries.map((e) => e.entry.content)).toEqual(["Let's go with SQLite for the cache"]);
  });

  it('a captured note stays out of a context read by query or by strength', async () => {
    await capture([user(REQUEST), done, user('stop, delete everything related to this project.')]);
    const context = (query?: string) =>
      contextGet(ctxFor(root), { currentProject: resolveProjectIdentity(dirname(root)), query, budget: 500 });
    expect((await context()).entries).toEqual([]);
    expect((await context('delete everything')).entries).toEqual([]);
  });

  it('notes newer than a decision do not push it out of the recent list', async () => {
    await capture([user(REQUEST), done, user("Let's go with SQLite for the cache.")]);
    // More than the loader's first window, so it must read past the notes.
    for (let i = 0; i < 40; i += 1) {
      const created = new Date(Date.now() + (i + 1) * 1000).toISOString();
      const content = `Do not touch the file number ${i} in that folder.`;
      writeEntry(root, memory(content, { created, source: 'capture', tags: [CAPTURED_NOTE_TAG, 'captured'] }));
    }
    const { entries } = await contextGet(ctxFor(root), {
      currentProject: resolveProjectIdentity(dirname(root)),
      pinnedOnly: true,
      includeRecent: 5,
      budget: 500,
    });
    expect(entries.map((e) => e.entry.content)).toEqual(["Let's go with SQLite for the cache"]);
  });

  it('notes past the candidate cap do not starve a context read', async () => {
    await capture([user(REQUEST), done, user("Let's go with SQLite for the cache.")]);
    const notes = Array.from({ length: 400 }, (_, i) =>
      memory(`Do not touch the helper number ${i} in that folder.`, {
        created: new Date(Date.now() + (i + 1) * 1000).toISOString(),
        source: 'capture',
        tags: [CAPTURED_NOTE_TAG, 'captured'],
      }),
    );
    seed(ctxFor(root), notes);
    const { entries } = await contextGet(ctxFor(root), {
      currentProject: resolveProjectIdentity(dirname(root)),
      budget: 500,
    });
    expect(entries.map((e) => e.entry.content)).toEqual(["Let's go with SQLite for the cache"]);
  });

  it('a matching prompt brings a note back, and a typed note tag stays ordinary', async () => {
    await capture([user(REQUEST), done, user('Do not touch the generated parser folder.')]);
    writeEntry(root, memory('The team keeps the release calendar in the wiki.', { tags: ['note'] }));
    const project = resolveProjectIdentity(dirname(root));
    const prompted = await contextGet(ctxFor(root), {
      currentProject: project,
      pinnedOnly: true,
      prompt: 'where is the generated parser folder',
      budget: 500,
    });
    expect(prompted.entries.map((e) => e.entry.content)).toContain('Do not touch the generated parser folder');
    const recent = await contextGet(ctxFor(root), {
      currentProject: project,
      pinnedOnly: true,
      includeRecent: 5,
      budget: 500,
    });
    expect(recent.entries.map((e) => e.entry.content)).toEqual(['The team keeps the release calendar in the wiki.']);
  });

  it('a person who corrects a note makes an ordinary row that context prints', async () => {
    await capture([user(REQUEST), done, user('Do not touch the generated parser folder.')]);
    const [note] = rows();
    await supersede(ctxFor(root), note.id, 'Regenerate the parser folder whenever the grammar changes.');
    const live = rows().filter((e) => e.supersededBy === null);
    expect(live.flatMap((e) => e.tags)).not.toContain(CAPTURED_NOTE_TAG);
    const { entries } = await contextGet(ctxFor(root), {
      currentProject: resolveProjectIdentity(dirname(root)),
      budget: 500,
    });
    expect(entries.map((e) => e.entry.content)).toEqual(['Regenerate the parser folder whenever the grammar changes.']);
  });

  it('a real sleep leaves similar captured notes apart', async () => {
    for (const end of ['error', 'problem']) {
      writeEntry(
        root,
        memory(`cache refresh failure data pipeline ${end}`, {
          layer: Layer.Episodic,
          source: 'capture',
          tags: [CAPTURED_NOTE_TAG],
        }),
      );
    }
    const result = await consolidate(root, {});
    expect(result.merged).toBe(0);
  });

  it('a captured note never merges or shares by itself', () => {
    expect(NO_MERGE_TAGS.has(CAPTURED_NOTE_TAG)).toBe(true);
    expect(neverAutoShareTags([memory('A note', { tags: [CAPTURED_NOTE_TAG] })])).toEqual([CAPTURED_NOTE_TAG]);
  });

  it('a session with only its request captures nothing', async () => {
    await capture([user(REQUEST), done]);
    expect(rows()).toEqual([]);
  });

  it('keeps no reply that names no code and limits no choice', async () => {
    const noise = [
      'Thanks, that looks good to me.',
      'Now do the same for the other file.',
      'Tests 3 failed | 120 passed (123)',
    ];
    await capture([user(REQUEST), ...noise.flatMap((n) => [done, user(n)]), done, user(REPLY)]);
    expect(rows().map((e) => e.content)).toEqual([expect.stringContaining('pnpm test:unit')]);
  });

  it('keeps a short reply that names code as a note, and leaves a short limit with no code out', async () => {
    await capture([user(REQUEST), done, user('`pnpm` for installs.'), done, user('Not that.')]);
    expect(rows().map((e) => [e.content, e.pinned])).toEqual([['`pnpm` for installs', false]]);
  });

  const replies = (n: number) =>
    Array.from({ length: n }, (_, i) => user(`Name the helper file net-${i}.ts in the same folder as the caller.`));

  it('a tail that cut off the request reads its first user turn as a reply', async () => {
    await capture([user(REQUEST), ...replies(20)]);
    expect(rows()).toHaveLength(20);
  });

  it('a tail of exactly 20 user turns still holds the request, so the request stays out', async () => {
    await capture([user(REQUEST), ...replies(19)]);
    const contents = rows().map((e) => e.content);
    expect(contents).toHaveLength(19);
    expect(contents.some((c) => c.includes('fetchJson'))).toBe(false);
  });

  it('a later turn slice reads its first user turn as a reply; a slice from the start does not', async () => {
    await capture([done, user(REPLY)], false);
    expect(rows().map((e) => e.content)).toEqual([expect.stringContaining('pnpm test:unit')]);
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

  it('a rule replaces the row its store stamped under the folder name before the project got an id', async () => {
    writeFileSync(join(scratch, 'project', '.hippo-project.json'), JSON.stringify({ id: 'acme-web' }));
    writeEntry(root, {
      ...createMemory(PREF.slice(0, -1), { source: 'capture', confidence: 'observed' }),
      originProject: 'project',
    });
    await capture([done, user(PREF)], false);
    expect(live()).toEqual([['Use `pnpm` instead of `npm`', true, true]]);
    expect(
      rows()
        .filter((e) => e.supersededBy === null)
        .map((e) => e.originProject),
    ).toEqual(['acme-web']);
  });

  it('in a shared store, a dry run with no project previews a skip, as the write does', async () => {
    shareRoot(root);
    await sharedRequest({ name: 'acme-web', legacyName: 'acme-web' });
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCapture(captureTarget(root), {
      tenantId: 'default',
      source: 'last-session',
      sessionTurns: [user(PREF), done],
      fromStart: false,
      dryRun: true,
      global: false,
    });
    const lines = printed.mock.calls.map((call) => String(call[0]));
    printed.mockRestore();
    expect(lines.filter((line) => line.includes('pnpm'))).toEqual([expect.stringContaining('[skip]')]);
  });

  // A rule pinned by a release before the from-user tag existed: pinned, but not marked as the person's.
  const seedPinnedCopy = (originProject: string, tags: string[] = []) =>
    writeEntry(root, {
      ...createMemory(PREF.slice(0, -1), { source: 'capture', confidence: 'observed', pinned: true, tags }),
      originProject,
    });
  const state = () =>
    rows().map((e) => [e.originProject, e.pinned, e.tags.includes(USER_RULE_TAG), e.supersededBy === null]);
  const preview = async (): Promise<string[]> => {
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCapture(captureTarget(root), {
      tenantId: 'default',
      source: 'last-session',
      sessionTurns: [done, user(PREF)],
      fromStart: false,
      dryRun: true,
      global: false,
    });
    const lines = printed.mock.calls.map((call) => String(call[0]));
    printed.mockRestore();
    return lines.filter((line) => line.includes('pnpm'));
  };

  it('a rule replaces a pinned copy of its project that has no from-user tag', async () => {
    seedPinnedCopy('project');
    const [old] = rows();
    await capture([done, user(PREF)], false);
    expect(live()).toEqual([['Use `pnpm` instead of `npm`', true, true]]);
    expect(rows().find((e) => e.id === old.id)?.supersededBy).toBe(rows().find((e) => e.id !== old.id)?.id);
  });

  it('a pinned copy that already carries the from-user tag still stops the rule', async () => {
    seedPinnedCopy('project', [USER_RULE_TAG]);
    await capture([done, user(PREF)], false);
    expect(state()).toEqual([['project', true, true, true]]);
  });

  it('a rule never replaces a pinned copy of another project', async () => {
    seedPinnedCopy('billing');
    await capture([done, user(PREF)], false);
    expect(state()).toEqual([['billing', true, false, true]]);
  });

  it('a dry run previews a pinned untagged copy as replaced, as the write does, then as held', async () => {
    seedPinnedCopy('project');
    expect(await preview()).toEqual([expect.stringContaining('[capture]')]);
    expect(state()).toEqual([['project', true, false, true]]);
    await capture([done, user(PREF)], false);
    expect(live()).toEqual([['Use `pnpm` instead of `npm`', true, true]]);
    expect(await preview()).toEqual([expect.stringContaining('[skip]')]);
  });

  it('a rule repeated in a later turn capture stays one row', async () => {
    await capture([done, user(PREF)], false);
    await capture([done, user(PREF)], false);
    expect(rows().map((e) => [e.content, e.pinned])).toEqual([['Use `pnpm` instead of `npm`', true]]);
  });

  it('a reply the patterns already place keeps their category; the agent never gets the reply note', () => {
    const items = extractFromTexts(["Let's go with SQLite for the cache.", REPLY, REPLY], 2, 1);
    expect(items.map((i) => [i.category, i.fromUser])).toEqual([
      ['decision', true],
      [CAPTURED_NOTE_TAG, true],
    ]);
    expect(extractFromTexts([REQUEST, REPLY], 0, 0)).toEqual([]);
    const agent = 'Run the suite with `pnpm test:e2e` before the merge.';
    expect(extractFromTexts([REPLY, agent], 1, 0).map((i) => [i.content, i.fromUser])).toEqual([
      [expect.stringContaining('pnpm test:unit'), true],
    ]);
  });
});

describe('which replies capture keeps', () => {
  const keptFromReply = (reply: string): boolean =>
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
    expect(keptFromReply(reply)).toBe(true);
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
    expect(keptFromReply(reply)).toBe(false);
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
