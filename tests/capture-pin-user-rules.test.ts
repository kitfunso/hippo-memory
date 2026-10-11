// A rule the person states is pinned at capture, so the prompt hook injects it on a later prompt that shares none of its words.
// Real SQLite stores in tmp dirs, no mocks.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCapture } from '../src/capture/command.js';
import { collectSessionTurns, type SessionTurn } from '../src/capture/transcript.js';
import { getContext, type Context } from '../src/api/index.js';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';

const TAUGHT = 'No: Put each change note in its own new file under changelog.d/ and never edit CHANGELOG.md by hand, because the release script builds CHANGELOG.md from those files. Please fix it.';
const USER_DECISION = "Let's go with SQLite for the cache because the app must work offline.";
const AGENT_RULE = 'The deploy script must run from the repository root because it reads relative paths.';
const LATER_PROMPT = 'Fix formatCents in src/money.js so it rounds half up';

describe('capture pins the rules a person states', () => {
  let scratch: string;
  let root: string;
  let priorHome: string | undefined;
  let ctx: Context;

  const capture = (turns: SessionTurn[]) => cmdCapture(root, { source: 'last-session', sessionTurns: turns, dryRun: false, global: false });
  const injected = async () => (await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: 'project', prompt: LATER_PROMPT }))
    .entries.map(({ entry }) => entry.content);

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hippo-pin-user-rules-'));
    root = join(scratch, 'project', '.hippo');
    initStore(root);
    const global = join(scratch, 'global');
    initStore(global);
    priorHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = global;
    ctx = { hippoRoot: root, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = priorHome;
    rmSync(scratch, { recursive: true, force: true });
  });

  it("pins the person's rule and leaves their decision and the agent's rule unpinned", () => {
    capture([{ role: 'user', text: `${TAUGHT} ${USER_DECISION}` }, { role: 'assistant', text: AGENT_RULE }]);
    const rows = loadAllEntries(root);
    expect(rows.filter((e) => e.pinned).map((e) => e.content)).toEqual([expect.stringContaining('never edit CHANGELOG.md')]);
    expect(rows.find((e) => e.content.startsWith("Let's go with SQLite"))?.pinned).toBe(false);
    expect(rows.find((e) => e.content.startsWith('The deploy script'))?.pinned).toBe(false);
  });

  it('the prompt hook injects the stated rule on a later prompt that shares none of its words', async () => {
    capture([{ role: 'user', text: TAUGHT }]);
    expect(await injected()).toEqual([expect.stringContaining('never edit CHANGELOG.md')]);
  });

  it("the same rule from the agent stays behind the prompt gate", async () => {
    capture([{ role: 'assistant', text: TAUGHT }]);
    expect(loadAllEntries(root).map((e) => e.content)).toEqual([expect.stringContaining('never edit CHANGELOG.md')]);
    expect(await injected()).toEqual([]);
  });

  it('a file capture names no speaker, so its rules stay unpinned', () => {
    const file = join(scratch, 'notes.md');
    writeFileSync(file, TAUGHT);
    cmdCapture(root, { source: 'file', filePath: file, dryRun: false, global: false });
    expect(loadAllEntries(root).map((e) => [e.content, e.pinned])).toEqual([[expect.stringContaining('never edit CHANGELOG.md'), false]]);
  });

  it('drops the context Codex stores as user messages, so none of it counts as the person speaking', () => {
    const line = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    const jsonl = [
      line('# AGENTS.md instructions for C:/repo\n\n<INSTRUCTIONS>\nNever push to main.\n</INSTRUCTIONS>'),
      line('<environment_context>\n  <cwd>C:/repo</cwd>\n</environment_context>'),
      line('<in-app-browser-context source="ambient-ui-state">\nAlways show the page.\n</in-app-browser-context>'),
      line('Never edit CHANGELOG.md by hand.'),
    ].join('\n');
    expect(collectSessionTurns(jsonl)).toEqual([{ role: 'user', text: 'Never edit CHANGELOG.md by hand.' }]);
  });
});
