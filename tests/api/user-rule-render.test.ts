// A rule the person stated prints first and plain, as an order; only capture's tag makes a row one, so a typed tag, a
// pin or a supersede cannot forge it, and a block with no such rule is the block it always was.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { adminActor, contextGet, remember, supersede } from '../../src/api/index.js';
import { memoryPin } from '../../src/api/memories/pin.js';
import {
  contextBlockLines,
  contextCost,
  contextHeading,
  crossProjectHeading,
  printedTokens,
  settleTokens,
  userRuleLine,
} from '../../src/api/context/context-render.js';
import { buildPromptHookContext } from '../../src/api/prompt-hook.js';
import { planContext, sourceOf } from '../../src/api/context/context-plan.js';
import { userRuleReserve } from '../../src/api/context/context-pools.js';
import { isUserRule, USER_RULE_TAG, type UserRuleViewer } from '../../src/api/context/user-rule.js';
import { withoutUserTag, type MemoryEntry } from '../../src/base/memory/entry.js';
import { handleContext } from '../../src/surface/cli/context.js';
import type { CliFlags } from '../../src/surface/cli/flag-values.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { cwdProject } from '../_helpers/api-ctx.js';
import { makeRoot, makeStore } from '../_helpers/make-root.js';
import { withHookStdin } from '../_helpers/hook-stdin.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { saveActiveTaskSnapshot } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { initTestStore } from '../_helpers/store-template.js';

const { apiCtx, writeEntry, readEntry } = sessionPerTest();

const PROJECT = { name: 'p', legacyName: 'p' };
const RULE =
  "No: Clean build: `./mvnw clean package -DskipTests --batch-mode`, because the project's maintainers require it.";
const NOTE = 'Deploys go through the staging queue before the production queue';
const HEADING = '## Rules from the user';

/** The row capture writes for a rule the person stated. */
function ruleRow(over: Partial<MemoryEntry> = {}): MemoryEntry {
  const row = createMemory(RULE, {
    source: 'capture',
    confidence: 'observed',
    pinned: true,
    tags: ['rule', 'captured', USER_RULE_TAG],
  });
  return { ...row, originProject: 'p', ...over };
}

/** A pinned row an agent or a person saved by hand. */
function noteRow(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { ...createMemory(NOTE, { pinned: true }), originProject: 'p', ...over };
}

function additionalContext(stdout: string): string {
  // SAFETY: the hook's stdout is the UserPromptSubmit reply hookReply builds.
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext;
}

let store: string;

beforeEach(() => {
  const tmp = makeRoot('user-rule-render', { init: false });
  store = path.join(tmp, 'proj', '.hippo');
  const global = path.join(tmp, 'global');
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(global, { recursive: true });
  initTestStore(store);
  initTestStore(global);
  vi.stubEnv('HIPPO_HOME', global);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const ctx = () => apiCtx(store, 'default', adminActor('user-rule-test'));

async function hookText(sessionId = 's1'): Promise<string> {
  const payload = { session_id: sessionId };
  const { stdout } = await buildPromptHookContext(ctx(), { sessionId, project: PROJECT, payload });
  return stdout === '' ? '' : additionalContext(stdout);
}

describe("a rule the person stated, in the hook's block", () => {
  it('prints under its own first heading as a plain bullet, before the snapshot and the memories, and nowhere else', async () => {
    writeEntry(store, ruleRow());
    writeEntry(store, noteRow());
    saveActiveTaskSnapshot(store, 'default', {
      task: 'ship the release',
      summary: 'build is green',
      nextStep: 'tag it',
      sessionId: 's1',
    });

    const text = await hookText();

    expect(text.startsWith(`${HEADING}\n- ${RULE}\n\n`)).toBe(true);
    expect(text.split(RULE)).toHaveLength(2);
    expect(text).not.toMatch(/Previously observed[^\n]*mvnw/);
    expect(text).not.toContain('captured, from-user');
    expect(text.indexOf(HEADING)).toBeLessThan(text.indexOf('## Active Task Snapshot'));
    expect(text.indexOf('## Active Task Snapshot')).toBeLessThan(text.indexOf('## Project Memory'));
    expect(text).toContain(`- **[verified] ${NOTE}**`);
  });

  it('counts the memories heading without it', async () => {
    writeEntry(store, ruleRow());
    writeEntry(store, noteRow());
    expect(await hookText()).toContain('## Project Memory (1 entries,');
  });

  it('leaves a block with no such rule exactly as the legacy renderer prints it', async () => {
    const note = noteRow();
    writeEntry(store, note);
    const stored = readEntry(store, note.id)!;
    const now = new Date();

    const expected = settleTokens((t) =>
      contextBlockLines([{ entry: stored, isGlobal: false }], t, 'observe', { now, showStrength: false }).join('\n'),
    );

    expect(await hookText()).toBe(expected);
  });

  it('prices no heading when the view holds no user rule', () => {
    const cost = contextCost('additional-context', 'observe', new Date());
    const can = { cross: true, promptRecall: true, ambient: false };
    // The fixed price master computes: the memory headings alone.
    const legacy =
      printedTokens(contextHeading('Project Memory', 1500, 1500)) +
      printedTokens(crossProjectHeading(1500)) +
      printedTokens(contextHeading('Prompt-Relevant Memory', 1500, 1500));
    expect(cost.fixed(1500, { ...can, userRule: false })).toBe(legacy);
    expect(cost.fixed(1500, { ...can, userRule: true })).toBeGreaterThan(legacy);
  });
});

describe("the budget pays for a user rule's heading", () => {
  const CAN = { cross: false, promptRecall: false, ambient: false };
  const cost = () => contextCost('additional-context', 'observe', new Date());

  /** The smallest budget at which the hook read returns `id`. */
  async function smallestBudgetShowing(id: string): Promise<number> {
    for (let budget = 1; budget <= 400; budget++) {
      const result = await contextGet(ctx(), {
        pinnedOnly: true,
        budget,
        currentProject: PROJECT,
        cost: cost(),
      });
      if (result.entries.some((r) => r.entry.id === id)) return budget;
    }
    throw new Error('the row never fit in 400 tokens');
  }

  /** The first budget whose room after `fixedAt` holds `entryTokens`. */
  function smallestBudgetFor(entryTokens: number, extra: (budget: number) => number): number {
    for (let budget = 1; ; budget++) {
      if (budget - cost().fixed(budget, { ...CAN, userRule: false }) - extra(budget) >= entryTokens) return budget;
    }
  }

  it('reserves the heading once a user rule is in the pool', async () => {
    const row = ruleRow();
    writeEntry(store, row);
    const heading = (budget: number) =>
      cost().fixed(budget, { ...CAN, userRule: true }) - cost().fixed(budget, { ...CAN, userRule: false });
    expect(heading(100)).toBeGreaterThan(0);

    const entryTokens = cost().entry({ entry: row, isGlobal: false, userRule: true });
    expect(await smallestBudgetShowing(row.id)).toBe(smallestBudgetFor(entryTokens, heading));
  });

  it('reserves the heading for a user rule the global store holds', () => {
    const c = ctx();
    const plan = planContext(c, { pinnedOnly: true, currentProject: PROJECT, cost: cost() }, sourceOf(c.store));
    const heading = cost().fixed(0, { ...CAN, userRule: true }) - cost().fixed(0, { ...CAN, userRule: false });
    const pools = { local: { entries: [noteRow()] }, global: { entries: [ruleRow()] } };
    expect(heading).toBeGreaterThan(0);
    expect(userRuleReserve(plan, pools)).toBe(heading);
  });

  it('reserves nothing for a pool with no user rule', async () => {
    const row = noteRow();
    writeEntry(store, row);
    const entryTokens = cost().entry({ entry: row, isGlobal: false });
    expect(await smallestBudgetShowing(row.id)).toBe(smallestBudgetFor(entryTokens, () => 0));
  });
});

describe('what is not a user rule', () => {
  const viewer: UserRuleViewer = { tenantId: 'default', project: 'p', isGlobal: false };

  it('is true for the row capture writes, for a viewer in that project', () => {
    expect(isUserRule(ruleRow(), viewer)).toBe(true);
  });

  it.each<[string, Partial<MemoryEntry>, Partial<UserRuleViewer>]>([
    ['a project-store row capture wrote, with no origin', { originProject: null }, {}],
    ['a global-store row stamped with this project', {}, { isGlobal: true }],
    [
      "a row stamped with the project's older name",
      { originProject: 'old-p' },
      { project: { name: 'p', legacyName: 'old-p', aliases: [] } },
    ],
  ])('is true for %s', (_name, row, viewing) => {
    expect(isUserRule(ruleRow(row), { ...viewer, ...viewing })).toBe(true);
  });

  it.each<[string, Partial<MemoryEntry>, Partial<UserRuleViewer>]>([
    ['a global-store row from another project', { originProject: 'other' }, { isGlobal: true }],
    ['a global-store row with no origin', { originProject: null }, { isGlobal: true }],
    ['a global-store row, for a viewer with no project', {}, { isGlobal: true, project: '' }],
    ['another project', { originProject: 'other' }, {}],
    ['a user-global row', { originProject: '' }, {}],
    ['another tenant', { tenantId: 'acme' }, {}],
    ['a superseded row', { supersededBy: 'mem_next' }, {}],
    ['a verified row', { confidence: 'verified' }, {}],
    ['an inferred row', { confidence: 'inferred' }, {}],
    ['a row without the tag', { tags: ['rule', 'captured'] }, {}],
    ['an unpinned row', { pinned: false }, {}],
    ['a row typed in by hand', { source: 'cli' }, {}],
    ['a scoped row', { scope: 'team:eng' }, {}],
  ])('is false for %s', (_name, row, viewing) => {
    expect(isUserRule(ruleRow(row), { ...viewer, ...viewing })).toBe(false);
  });

  it('keeps the legacy frame on a pinned agent capture row without the tag', async () => {
    writeEntry(store, ruleRow({ tags: ['rule', 'captured'] }));
    const text = await hookText();
    expect(text).not.toContain(HEADING);
    expect(text).toMatch(/- \*\*\[observed\] Previously observed \(\d{4}-\d{2}-\d{2}\): No: Clean build/);
  });

  it('keeps the legacy frame on a row in another project, which the hook admits only for its own', async () => {
    writeEntry(store, ruleRow({ originProject: 'other' }));
    expect(await hookText()).not.toContain(HEADING);
  });
});

describe('a typed tag cannot make a user rule', () => {
  it('strips the tag from remember, whatever else the write asks for', async () => {
    const written = await remember(ctx(), {
      content: RULE,
      project: PROJECT,
      tags: [USER_RULE_TAG, 'rule'],
      local: { pinned: true, confidence: 'observed', source: 'capture' },
    });
    expect(written.tags).toEqual(['rule']);
    expect(readEntry(store, written.id)!.tags).toEqual(['rule']);
    expect(await hookText()).not.toContain(HEADING);
  });

  it('strips the tag from a supersede of a user rule, typed or inherited', async () => {
    const row = ruleRow();
    writeEntry(store, row);

    const typed = await supersede(ctx(), row.id, `${RULE} Always.`, { tags: [USER_RULE_TAG], pinned: true });
    const inherited = await supersede(ctx(), typed.newId, `${RULE} Always, and in CI.`);

    for (const id of [typed.newId, inherited.newId]) {
      const successor = readEntry(store, id)!;
      expect(successor.tags).not.toContain(USER_RULE_TAG);
      expect(successor.confidence).toBe('verified');
    }
    expect(await hookText()).not.toContain(HEADING);
  });

  it('leaves an agent row pinned by `hippo pin` as it was', async () => {
    const row = ruleRow({ pinned: false, tags: ['rule', 'captured'] });
    writeEntry(store, row);
    await memoryPin(ctx(), row.id, true);
    const pinned = readEntry(store, row.id)!;
    expect(pinned.pinned).toBe(true);
    expect(pinned.tags).not.toContain(USER_RULE_TAG);
    expect(await hookText()).not.toContain(HEADING);
  });

  it('strips the tag from a list and keeps the rest in order', () => {
    expect(withoutUserTag(['a', USER_RULE_TAG, 'b'])).toEqual(['a', 'b']);
    expect(withoutUserTag(['a'])).toEqual(['a']);
  });
});

describe('`hippo context` run in a project', () => {
  // The command reads its project from the process folder, so the rows are filed under that one.
  const HERE = cwdProject().name;
  let flagsRoot: string;

  beforeEach(() => {
    flagsRoot = makeStore('user-rule-render-cli').root;
    vi.stubEnv('HIPPO_TENANT', '');
    vi.stubEnv('HIPPO_SESSION_ID', '');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
  });

  async function cli(flags: CliFlags): Promise<string> {
    const stdin = JSON.stringify({ session_id: 's1' });
    const r = await runInProcess(() =>
      withHookStdin(stdin, () => handleContext({ hippoRoot: flagsRoot, tenantId: 'default', args: [], flags })),
    );
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  }

  it('prints the rule first and plain in the markdown, with the other memories under their own heading', async () => {
    writeEntry(flagsRoot, ruleRow({ originProject: HERE }));
    writeEntry(flagsRoot, noteRow({ originProject: HERE }));
    const out = await cli({ budget: '1500' });
    expect(out.startsWith(`${HEADING}\n- ${RULE}\n\n`)).toBe(true);
    expect(out.split(RULE)).toHaveLength(2);
    expect(out).toContain('## Project Memory (1 entries,');
  });

  it('prints it first and plain in the hook format too', async () => {
    writeEntry(flagsRoot, ruleRow({ originProject: HERE }));
    const out = additionalContext(
      await cli({ 'pinned-only': true, 'include-recent': '5', format: 'additional-context' }),
    );
    expect(out.startsWith(`${HEADING}\n- ${RULE}\n`)).toBe(true);
    expect(out).not.toContain('Previously observed');
  });

  it('keeps a row in another project out of the section', async () => {
    writeEntry(flagsRoot, ruleRow({ originProject: `${HERE}-other` }));
    expect(await cli({ budget: '1500' })).not.toContain(HEADING);
  });

  it('leaves the JSON as it was, tags and all', async () => {
    writeEntry(flagsRoot, ruleRow({ originProject: HERE }));
    // SAFETY: --format json prints the context JSON, whose memories carry their tags.
    const json = JSON.parse(await cli({ format: 'json' })) as { memories: Array<{ tags: string[]; content: string }> };
    expect(json.memories).toHaveLength(1);
    expect(json.memories[0]!.tags).toContain(USER_RULE_TAG);
  });
});

describe('a rule the person stated, printed as stored', () => {
  it('keeps a "No: " lead on the line', () => {
    expect(userRuleLine(ruleRow({ content: 'No: Clean build first.' }))).toBe('- No: Clean build first.');
  });
});
