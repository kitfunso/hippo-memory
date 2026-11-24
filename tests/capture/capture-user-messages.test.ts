import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture, type CaptureOptions } from '../../src/surface/capture/command.js';
import { captureTarget } from '../_helpers/cli-stores.js';
import type { SessionTurn } from '../../src/surface/capture/transcript.js';
import { contextGet, retrieve } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries, writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, USER_MESSAGE_TAG, USER_RULE_TAG } from '../../src/base/memory/entry.js';

const KIBO = "[2023-01-11] gave kibo a bite of my curry and now he won't come near me. cats hold grudges";
const PRIYA = "Priya's onboarding mocks landed well in review today";
const REPLY = 'Noted, sounds like Kibo has had a long day.';
const COLOUR = 'my favourite colour is green';
const MAX_CHARS = 2000;

describe('capture saves what the person types', () => {
  let scratch: string;
  let root: string;
  let ctx: FullContext;

  const capture = (turns: SessionTurn[], extra: Partial<CaptureOptions> = {}) =>
    runCapture(captureTarget(root), {
      tenantId: 'default',
      source: 'last-session',
      sessionTurns: turns,
      sessionId: 'sess-1',
      saveMessages: true,
      dryRun: false,
      global: false,
      ...extra,
    });
  const messages = () => loadAllEntries(root, 'default').filter((e) => e.tags.includes(USER_MESSAGE_TAG));
  const texts = () =>
    messages()
      .map((e) => e.content)
      .sort();

  beforeEach(() => {
    scratch = makeRoot('user-messages', { init: false });
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

  it('saves each user turn whole, as a raw row with its owner, session and source', async () => {
    await capture([
      { role: 'user', text: KIBO },
      { role: 'assistant', text: REPLY },
      { role: 'user', text: PRIYA },
      { role: 'user', text: COLOUR },
    ]);
    const rows = messages();
    expect(texts()).toEqual([KIBO, PRIYA, COLOUR].sort());
    for (const row of rows) {
      expect(row.kind).toBe('raw');
      expect(row.source).toBe('user-message');
      expect(row.owner).toBe('user:local');
      expect(row.sourceSessionId).toBe('sess-1');
      expect(row.artifactRef).toMatch(/^session:sess-1\/[0-9a-f]{12}$/);
      expect(row.pinned).toBe(false);
    }
  });

  it("never saves the agent's reply as a user message", async () => {
    await capture([{ role: 'assistant', text: REPLY }]);
    expect(messages()).toEqual([]);
  });

  it('saves nothing for a capture no session-end worker asked to save messages', async () => {
    await capture([{ role: 'user', text: KIBO }], { saveMessages: undefined });
    expect(messages()).toEqual([]);
  });

  it('skips a short reply and a message that is only code', async () => {
    await capture([
      { role: 'user', text: 'ok thanks' },
      { role: 'user', text: '```ts\nconst total = items.reduce((a, b) => a + b, 0);\n```' },
    ]);
    expect(messages()).toEqual([]);
  });

  it('cuts a long message and masks an email address in it', async () => {
    const long = `Send the report to dana@example.com before Friday. ${'The quarterly numbers look fine. '.repeat(120)}`;
    await capture([{ role: 'user', text: long }]);
    const [row] = messages();
    expect(row.content.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(row.content).not.toContain('dana@example.com');
  });

  it('keeps the question after a long paste, not the paste', async () => {
    const paste = `\`\`\`\n${'at build (src/index.ts:12:3)\n'.repeat(120)}\`\`\``;
    await capture([{ role: 'user', text: `${paste}\nwhy does the build fail on the second run only?` }]);
    const [row] = messages();
    expect(row.content).toContain('why does the build fail on the second run only?');
    expect(row.content).not.toContain('at build');
  });

  it('masks an address and a key that bold markers split', async () => {
    await capture([
      { role: 'user', text: 'Send every sign-off request to **reviewer**@example.invalid by Friday noon.' },
      { role: 'user', text: 'Never commit **api_key**=9f8e7d6c5b4a3210ffff to the repo, it leaked last week.' },
    ]);
    const stored = messages()
      .map((e) => e.content)
      .join('\n');
    expect(stored).not.toContain('reviewer@example.invalid');
    expect(stored).not.toContain('9f8e7d6c5b4a3210ffff');
  });

  it('stores a message once when a turn close and the full close both read it', async () => {
    await capture([{ role: 'user', text: KIBO }]);
    await capture([
      { role: 'user', text: KIBO },
      { role: 'user', text: PRIYA },
    ]);
    expect(texts()).toEqual([KIBO, PRIYA].sort());
  });

  it('keeps a stated rule and the message that states it, so a saved message never stops the rule', async () => {
    const rule = 'Never push to main without a review';
    await capture([{ role: 'user', text: rule }]);
    await capture([{ role: 'user', text: rule }]);
    const rows = loadAllEntries(root, 'default');
    expect(rows.filter((e) => e.pinned && e.tags.includes(USER_RULE_TAG))).toHaveLength(1);
    expect(texts()).toEqual([rule]);
  });

  it('recall finds a saved message, and the recent list of the prompt hook leaves it out', async () => {
    await capture([{ role: 'user', text: KIBO }]);
    const found = await retrieve(ctx, { query: 'kibo curry grudges' });
    expect(found.results.map((r) => r.content)).toContain(KIBO);
    const injected = await contextGet(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: 'project' });
    expect(injected.entries.map(({ entry }) => entry.content)).not.toContain(KIBO);
  });

  it('newer messages do not push an older lesson out of the recent list', async () => {
    const lesson = 'Run npm run build before the tests in hippo, because the tests import dist/.';
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeEntry(root, { ...createMemory(lesson, { layer: Layer.Episodic }), created: dayAgo });
    await capture(
      Array.from({ length: 40 }, (_, i) => ({
        role: 'user' as const,
        text: `On day ${i} of March Priya and I repotted the Leeds allotment tomatoes into bigger pots`,
      })),
    );
    const injected = await contextGet(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: 'project' });
    expect(injected.entries.map(({ entry }) => entry.content)).toContain(lesson);
  });

  it('saves nothing when capture.userMessages is false', async () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ capture: { userMessages: false } }));
    await capture([{ role: 'user', text: KIBO }]);
    expect(messages()).toEqual([]);
  });
});
