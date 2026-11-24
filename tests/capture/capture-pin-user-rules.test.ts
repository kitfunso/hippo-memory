import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from '../../src/surface/capture/command.js';
import { captureTarget } from '../_helpers/cli-stores.js';
import { collectSessionTurns, type SessionTurn } from '../../src/surface/capture/transcript.js';
import { contextGet } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { CAPTURED_NOTE_TAG, USER_RULE_TAG } from '../../src/base/memory/entry.js';

const TAUGHT =
  'No: Put each change note in its own new file under changelog.d/ and never edit CHANGELOG.md by hand, because the release script builds CHANGELOG.md from those files. Please fix it.';
const USER_DECISION = "Let's go with SQLite for the cache because the app must work offline.";
const AGENT_RULE = 'The deploy script must run from the repository root because it reads relative paths.';
const LATER_PROMPT = 'Fix formatCents in src/money.js so it rounds half up';

describe('capture pins the rules a person states', () => {
  let scratch: string;
  let root: string;
  let ctx: FullContext;

  const capture = (turns: SessionTurn[]) =>
    runCapture(captureTarget(root), {
      tenantId: 'default',
      source: 'last-session',
      sessionTurns: turns,
      dryRun: false,
      global: false,
    });
  const injected = async () =>
    (
      await contextGet(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: 'project', prompt: LATER_PROMPT })
    ).entries.map(({ entry }) => entry.content);

  beforeEach(() => {
    scratch = makeRoot('pin-user-rules', { init: false });
    root = join(scratch, 'project', '.hippo');
    initTestStore(root);
    const global = join(scratch, 'global');
    initTestStore(global);
    vi.stubEnv('HIPPO_HOME', global);
    ctx = apiCtx(root, 'default', { subject: 'cli', role: 'admin' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins the person's rule and leaves their decision and the agent's rule unpinned", async () => {
    await capture([
      { role: 'user', text: `${TAUGHT} ${USER_DECISION}` },
      { role: 'assistant', text: AGENT_RULE },
    ]);
    const rows = loadAllEntries(root, 'default');
    expect(rows.filter((e) => e.pinned).map((e) => e.content)).toEqual([
      expect.stringContaining('never edit CHANGELOG.md'),
    ]);
    expect(rows.find((e) => e.content.startsWith("Let's go with SQLite"))?.pinned).toBe(false);
    expect(rows.find((e) => e.content.startsWith('The deploy script'))?.pinned).toBe(false);
  });

  it('the prompt hook injects the stated rule on a later prompt that shares none of its words', async () => {
    await capture([{ role: 'user', text: TAUGHT }]);
    expect(await injected()).toEqual([expect.stringContaining('never edit CHANGELOG.md')]);
  });

  it('the same rule from the agent stays behind the prompt gate', async () => {
    await capture([{ role: 'assistant', text: TAUGHT }]);
    expect(loadAllEntries(root, 'default').map((e) => e.content)).toEqual([
      expect.stringContaining('never edit CHANGELOG.md'),
    ]);
    expect(await injected()).toEqual([]);
  });

  it('a file capture names no speaker, so its rules stay unpinned', async () => {
    const file = join(scratch, 'notes.md');
    writeFileSync(file, TAUGHT);
    await runCapture(captureTarget(root), {
      tenantId: 'default',
      source: 'file',
      filePath: file,
      dryRun: false,
      global: false,
    });
    expect(loadAllEntries(root, 'default').map((e) => [e.content, e.pinned])).toEqual([
      [expect.stringContaining('never edit CHANGELOG.md'), false],
    ]);
  });

  it('drops the context Codex stores as user messages, so none of it counts as the person speaking', () => {
    const line = (text: string) =>
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      });
    const jsonl = [
      line('# AGENTS.md instructions for C:/repo\n\n<INSTRUCTIONS>\nNever push to main.\n</INSTRUCTIONS>'),
      line('<environment_context>\n  <cwd>C:/repo</cwd>\n</environment_context>'),
      line('<in-app-browser-context source="ambient-ui-state">\nAlways show the page.\n</in-app-browser-context>'),
      line('Never edit CHANGELOG.md by hand.'),
    ].join('\n');
    expect(collectSessionTurns(jsonl)).toEqual([{ role: 'user', text: 'Never edit CHANGELOG.md by hand.' }]);
  });

  describe('a session a program drives', () => {
    const WRAPPER_PROMPT =
      'You are Cline, an AI coding agent. Always gather all the necessary context before starting to work on a task. Always use absolute paths when referring to files.';
    const claudeLine = (entrypoint: string, text: string, promptSource = 'sdk') =>
      JSON.stringify({ type: 'user', entrypoint, promptSource, message: { role: 'user', content: text } });
    const reply = JSON.stringify({
      type: 'assistant',
      entrypoint: 'sdk-cli',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    });
    const codexSession = (source: string | { subagent: string }, text: string) =>
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 's1', source } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        }),
      ].join('\n');

    it('pins nothing from the prompt a wrapper sends through `claude -p`', async () => {
      const turns = collectSessionTurns([claudeLine('sdk-cli', WRAPPER_PROMPT), reply].join('\n'));
      expect(turns).toEqual([{ role: 'assistant', text: 'Done.' }]);
      await capture(turns);
      expect(loadAllEntries(root, 'default').filter((e) => e.pinned)).toEqual([]);
    });

    it.each(['sdk-cli', 'sdk-ts', 'sdk-py', 'claude-code-github-action'])(
      'reads no user turn from entrypoint %s',
      (entrypoint) => {
        expect(collectSessionTurns(claudeLine(entrypoint, TAUGHT))).toEqual([]);
      },
    );

    it.each(['cli', 'claude-vscode', 'claude-desktop'])(
      'keeps the typed prompt from entrypoint %s, even stamped sdk',
      (entrypoint) => {
        expect(collectSessionTurns(claudeLine(entrypoint, TAUGHT))).toEqual([{ role: 'user', text: TAUGHT }]);
      },
    );

    it('keeps the prompt when the harness says it plays the person', async () => {
      const turns = collectSessionTurns(claudeLine('sdk-cli', TAUGHT), undefined, { scriptedIsHuman: true });
      expect(turns).toEqual([{ role: 'user', text: TAUGHT }]);
      await capture(turns);
      expect(
        loadAllEntries(root, 'default')
          .filter((e) => e.pinned)
          .map((e) => e.content),
      ).toEqual([expect.stringContaining('never edit CHANGELOG.md')]);
    });

    it.each([['exec'], [{ subagent: 'review' }]])('reads no user turn from a Codex session started by %j', (source) => {
      expect(collectSessionTurns(codexSession(source, TAUGHT))).toEqual([]);
    });

    it.each([['cli'], ['vscode']])('keeps the typed prompt in a Codex %s session', (source) => {
      expect(collectSessionTurns(codexSession(source, TAUGHT))).toEqual([{ role: 'user', text: TAUGHT }]);
    });

    it('keeps a codex exec prompt when the harness says it plays the person', () => {
      expect(collectSessionTurns(codexSession('exec', TAUGHT), undefined, { scriptedIsHuman: true })).toEqual([
        { role: 'user', text: TAUGHT },
      ]);
    });
  });

  describe('scope', () => {
    const REQUEST = 'Add a retry with backoff to fetchJson in src/net.ts.';
    const done: SessionTurn = { role: 'assistant', text: 'Added the retry and its test.' };
    const stored = () =>
      loadAllEntries(root, 'default').map((e) => [e.content, e.pinned, e.tags.includes(CAPTURED_NOTE_TAG)]);

    it.each([
      'make sure there are no mistakes in the draft.',
      'We must aim high on this one, the plan sounds good, go.',
      'Can you make sure all the holiday tables are correct for the 33 zones, then continue.',
      'Ensure the chart from the post is on slide 4.',
    ])('keeps the task order %s as an unpinned note', async (reply) => {
      await capture([{ role: 'user', text: REQUEST }, done, { role: 'user', text: reply }]);
      expect(stored()).toEqual([[expect.any(String), false, true]]);
    });

    it('keeps a task order in the request as an unpinned note', async () => {
      await capture([{ role: 'user', text: 'Build the landing page, and make sure each mockup looks different.' }]);
      expect(stored()).toEqual([['Build the landing page, and make sure each mockup looks different', false, true]]);
    });

    it.each([
      'She has never used the premium screen: it is too much text.',
      'Most tools pile up notes the agent never reads back.',
      'You always have had doubts about what can be done.',
      'The release notes (never skip the review) live in the wiki.',
      'Because obviously we never worked on these before.',
      'You never told me the build was red.',
      'We always shipped on Fridays.',
      'merge 1255 1257 1259 1260, release 3.10.0; remove the 4 pinned rows; skip quizzes',
    ])('pins no description or aside: %s', async (reply) => {
      await capture([{ role: 'user', text: REQUEST }, done, { role: 'user', text: reply }]);
      expect(loadAllEntries(root, 'default').filter((e) => e.pinned)).toEqual([]);
    });

    it.each([
      'Never commit directly to `main`.',
      'No: you should never log a token.',
      'Keep them on this machine, and never send them to an outside service.',
      "Don't ever force-push the release branch.",
      'Tokens should never be written to `debug.log`.',
      'From now on, run the linter before each push.',
      'Use the local model for all audio going forward.',
      'I have told you many times: spawn sub-agents for wide searches.',
      'Important: the `staging` database is read only for migrations.',
      'We must run each benchmark the way its authors did, I have told you many times.',
      'We never feed the raw transcript to the judge.',
      'You never embed a key in a test fixture.',
      'Keep the keys in the vault, never committed to git.',
    ])('pins the lasting rule %s', async (reply) => {
      await capture([{ role: 'user', text: REQUEST }, done, { role: 'user', text: reply }]);
      const rows = loadAllEntries(root, 'default');
      expect(rows.map((e) => [e.pinned, e.tags.includes(USER_RULE_TAG)])).toEqual([[true, true]]);
    });

    it('pins a lasting rule in the request', async () => {
      await capture([{ role: 'user', text: 'Always write the plan to a file before you start.' }]);
      expect(stored()).toEqual([['Always write the plan to a file before you start', true, false]]);
    });
  });
});
