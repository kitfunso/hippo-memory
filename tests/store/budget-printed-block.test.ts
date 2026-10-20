// A token budget bounds the text that reaches the model, on every surface that prints memories.
// Real SQLite stores and the CLI entry in process; the long tags make the printed text cost far more than the content.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { estimateTokens } from '../../src/base/util/token-text.js';
import { assemble, drillDown, type Context } from '../../src/api/index.js';
import { assembleCost, drillCost } from '../../src/api/context-render.js';
import { handleMcpRequest, type McpResponse } from '../../src/surface/mcp/server.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { withHookStdin } from '../_helpers/hook-stdin.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeStore } from '../_helpers/make-root.js';
import { loadLastRecall, writeEntry } from '../_helpers/root-forms.js';
import { loadConfig } from '../../src/base/config/config.js';
const TAGS = [
  'deployment-pipeline-infrastructure-alpha',
  'database-migration-rollback-procedure',
  'observability-alerting-runbook-owner',
  'incident-review-follow-up-action-item',
  'customer-facing-latency-regression',
  'quarterly-reliability-objective-review',
];
const NOTES = 12;
const OVERSIZE = `Zanzibar ferry timetable: ${Array.from({ length: 300 }, (_, i) => `stop${i}`).join(' ')}`;

interface LedgerRow {
  surface: string;
  tokens: number;
}
type McpArgs = Record<string, string | number | boolean>;

const savedCwd = process.cwd();
let root: string;
let hippoDir: string;
let ids: Map<string, string>;

function noteText(i: number): string {
  return `Project note n${String(i).padStart(2, '0')}: the general rollback plan for the postgres migration keeps a dry run first`;
}

function seed(content: string, extra: Partial<MemoryEntry> = {}): string {
  const e = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: TAGS }), ...extra };
  writeEntry(hippoDir, e);
  return e.id;
}

function seedNotes(extra: Partial<MemoryEntry> = {}): void {
  for (let i = 0; i < NOTES; i++) ids.set(noteText(i), seed(noteText(i), extra));
}

async function hippo(args: string[], input?: string): Promise<string> {
  const res = await withHookStdin(input, () => runInProcess(() => runCli(['node', 'hippo', ...args])));
  expect(res.status, res.stderr).toBe(0);
  return res.stdout;
}

// console.log's newline is the terminal's, not the block's.
function block(stdout: string): string {
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}

function headerTokens(text: string, pattern: RegExp): number {
  const m = pattern.exec(text);
  expect(m, `no header matching ${pattern} in:\n${text}`).not.toBeNull();
  return Number(m![1]);
}

function shownNotes(text: string): string[] {
  return [...ids.keys()].filter((c) => text.includes(c));
}

function ledger(): LedgerRow[] {
  const db = openHippoDb(hippoDir);
  try {
    // SAFETY: the SELECT names exactly these two token_ledger columns.
    return (
      db.prepare('SELECT surface, tokens FROM token_ledger ORDER BY id').all() as Array<{
        surface: string;
        tokens: number;
      }>
    ).map((r) => ({ surface: String(r.surface), tokens: Number(r.tokens) }));
  } finally {
    closeHippoDb(db);
  }
}

function retrievalCount(id: string): number {
  const db = openHippoDb(hippoDir);
  try {
    // SAFETY: the SELECT names exactly this one column.
    return (db.prepare('SELECT retrieval_count FROM memories WHERE id = ?').get(id) as { retrieval_count: number })
      .retrieval_count;
  } finally {
    closeHippoDb(db);
  }
}

async function mcpText(name: string, args: McpArgs): Promise<string> {
  const res: McpResponse | null = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    {
      hippoRoot: hippoDir,
      tenantId: 'default',
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(hippoDir),
      config: loadConfig(hippoDir),
    },
  );
  // SAFETY: tools/call answers carry one MCP text content block.
  return (res?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? '';
}

// Every note matches and costs the same, so the count shown is the budget's fit; min < max only where a hint varies.
function expectBudgetBinds(text: string, min: number, max: number = min): void {
  const shown = shownNotes(text).length;
  expect(shown).toBeGreaterThanOrEqual(min);
  expect(shown).toBeLessThanOrEqual(max);
}

beforeEach(() => {
  ({ base: root, root: hippoDir } = makeStore('budget-block'));
  ids = new Map();
  vi.stubEnv('HIPPO_HOME', path.join(root, 'global'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  for (const k of ['ANTHROPIC_API_KEY', 'HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']) vi.stubEnv(k, undefined);
  process.chdir(root);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
});

describe('hippo context', () => {
  it.each([
    ['a query', ['context', 'postgres', 'rollback', '--budget', '400']],
    ['no query', ['context', '--budget', '400']],
  ])('markdown with %s prints within the budget; the header and the ledger count the block', async (_label, args) => {
    seedNotes();
    const text = block(await hippo(args));
    expect(estimateTokens(text)).toBeLessThanOrEqual(400);
    expect(headerTokens(text, /## Project Memory \(\d+ entries, (\d+) tokens\)/)).toBe(estimateTokens(text));
    // The heading and ambient footer reserve 12 + 56 tokens, and each note line prices at 88, so 332 fits 3.
    expectBudgetBinds(text, 3);
    expect(ledger().at(-1)).toEqual({ surface: 'context', tokens: estimateTokens(text) });
  });

  it('the per-prompt hook fits the budget, and each block header and ledger row counts its own block', async () => {
    fs.writeFileSync(
      path.join(hippoDir, 'config.json'),
      JSON.stringify({
        pinnedInject: { promptRecall: true, promptRecallThreshold: 0.1, promptRecallMinShared: 1 },
      }),
    );
    seedNotes();
    seed('Pinned rule one: always run the postgres migration dry run before a deploy', { pinned: true });
    seed('Pinned rule two: never drop a column in the same release that stops reading it', { pinned: true });
    const out = await hippo(
      ['context', '--pinned-only', '--format', 'additional-context', '--budget', '600'],
      JSON.stringify({ session_id: 'sess-budget', prompt: 'postgres migration rollback plan dry run' }),
    );
    // SAFETY: the hook prints one hookSpecificOutput JSON object.
    const ac = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    expect(estimateTokens(ac)).toBeLessThanOrEqual(600);
    const cut = ac.indexOf('## Prompt-Relevant Memory');
    // The static block is a 42-char heading and the two pin lines (326 and 330 chars), then a blank line.
    expect(cut).toBe(702);
    const staticBlock = ac.slice(0, cut - 2);
    const recallBlock = ac.slice(cut);
    expect(headerTokens(staticBlock, /## Project Memory \(\d+ entries, (\d+) tokens\)/)).toBe(
      estimateTokens(staticBlock),
    );
    expect(headerTokens(recallBlock, /## Prompt-Relevant Memory \(\d+ entries, (\d+) tokens\)/)).toBe(
      estimateTokens(recallBlock),
    );
    // Headings take 12 + 14 and the pins 82 + 83 of 600, so 409 holds 4 of the 5 gated 87-token notes.
    expectBudgetBinds(recallBlock, 4);
    expect(ledger()).toEqual([
      { surface: 'hook', tokens: estimateTokens(staticBlock) },
      { surface: 'hook_recall', tokens: estimateTokens(recallBlock) },
    ]);
  });

  it('an entry the budget leaves out gets no retrieval bump and is not in last_retrieval_ids', async () => {
    seedNotes();
    const text = block(await hippo(['context', 'postgres', 'rollback', '--budget', '400']));
    expectBudgetBinds(text, 3);
    const shown = shownNotes(text).map((c) => ids.get(c)!);
    for (const id of ids.values()) expect(retrievalCount(id)).toBe(shown.includes(id) ? 1 : 0);
    expect([...loadLastRecall(hippoDir).last_retrieval_ids].sort()).toEqual([...shown].sort());
  });

  it('skips an entry that alone exceeds the budget and keeps filling, with or without a query', async () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    seedNotes({ created: old, lastRetrieved: old });
    const big = seed(OVERSIZE);
    const all = block(await hippo(['context', '--budget', '400']));
    expect(all).not.toContain('Zanzibar');
    // The oversize entry is skipped, and an old note still prices at 88 (strength priced at 100%), so 3 fit.
    expectBudgetBinds(all, 3);
    expect(await hippo(['context', 'zanzibar', 'ferry', '--budget', '400'])).not.toContain('Zanzibar');
    expect(retrievalCount(big)).toBe(0);
  });
});

describe('hippo recall', () => {
  it('prints within the budget; the header and the ledger count the block, and JSON picks the same memories', async () => {
    seedNotes();
    const text = block(await hippo(['recall', 'postgres rollback', '--budget', '400']));
    expect(estimateTokens(text)).toBeLessThanOrEqual(400);
    expect(headerTokens(text, /Found \d+ memories \((\d+) tokens\)/)).toBe(estimateTokens(text));
    // 385 after the header fits 3 notes at 109; when their created times differ, the availability hint pushes 3 past 400.
    expectBudgetBinds(text, 2, 3);
    expect(ledger().at(-1)).toEqual({ surface: 'recall', tokens: estimateTokens(text) });

    const json = block(await hippo(['recall', 'postgres rollback', '--budget', '400', '--json']));
    // SAFETY: recall --json prints { results: [{ content }] }.
    const picked = (JSON.parse(json) as { results: Array<{ content: string }> }).results.map((r) => r.content);
    expect(picked.sort()).toEqual(shownNotes(text).sort());
    expect(ledger().at(-1)).toEqual({ surface: 'recall', tokens: estimateTokens(json) });
  });

  it('an entry the budget leaves out gets no retrieval bump and is not in last_retrieval_ids', async () => {
    seedNotes();
    const text = block(await hippo(['recall', 'postgres rollback', '--budget', '400']));
    expectBudgetBinds(text, 2, 3);
    const shown = shownNotes(text).map((c) => ids.get(c)!);
    for (const id of ids.values()) expect(retrievalCount(id)).toBe(shown.includes(id) ? 1 : 0);
    expect([...loadLastRecall(hippoDir).last_retrieval_ids].sort()).toEqual([...shown].sort());
  });

  it('keeps its --min-results floor for an entry larger than the whole budget, and says so in the header', async () => {
    seedNotes();
    seed(OVERSIZE);
    const kept = block(await hippo(['recall', 'zanzibar ferry', '--budget', '400']));
    expect(kept).toContain('Zanzibar ferry timetable');
    expect(headerTokens(kept, /Found \d+ memories \((\d+) tokens\)/)).toBe(estimateTokens(kept));
    expect(estimateTokens(kept)).toBeGreaterThan(400);
    const floorless = block(await hippo(['recall', 'zanzibar ferry', '--budget', '400', '--min-results', '0']));
    expect(floorless).not.toContain('Zanzibar ferry timetable');
    expect(estimateTokens(floorless)).toBeLessThanOrEqual(400);
  });
});

describe('MCP recall and context', () => {
  // A 7-token heading reserve leaves 393 for 90-token notes, so 4; recall cuts one when its availability hint prints.
  it.each([
    ['hippo_recall', 'mcp_recall', { query: 'postgres rollback', budget: 400 }, 3, 4],
    ['hippo_context', 'mcp_context', { budget: 400 }, 4, 4],
  ])('%s returns text within the budget and books that text', async (tool, surface, args, min, max) => {
    seedNotes();
    const text = await mcpText(tool, args);
    expect(estimateTokens(text)).toBeLessThanOrEqual(400);
    expectBudgetBinds(text, min, max);
    for (const [content, id] of ids) expect(retrievalCount(id)).toBe(text.includes(content) ? 1 : 0);
    expect(ledger().at(-1)).toEqual({ surface, tokens: estimateTokens(text) });
  });
});

describe('assemble and drill', () => {
  const ctx: Omit<Context, 'hippoRoot' | 'store' | 'config'> = {
    tenantId: 'default',
    actor: { subject: 'test:budget', role: 'admin' },
  };
  const sid = 'sess-budget-window';
  const line = (i: number): string => `Session message m${i}: ${'the rollback runbook step and its owner '.repeat(5)}`;

  function seedSession(n: number): string[] {
    return Array.from({ length: n }, (_, i) => {
      const e = createMemory(line(i), {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Buffer,
        kind: 'raw',
        sourceSessionId: sid,
        tags: TAGS,
      });
      e.created = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
      writeEntry(hippoDir, e);
      return e.id;
    });
  }

  function seedSummary(children: number): string {
    const s = createMemory('Rollup of the rollback runbook thread', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
      tags: ['dag-summary'],
    });
    s.descendantCount = children;
    writeEntry(hippoDir, s);
    for (let i = 0; i < children; i++) {
      const c = createMemory(line(i), {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        dagLevel: 1,
        dagParentId: s.id,
        tags: TAGS,
      });
      c.created = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
      writeEntry(hippoDir, c);
    }
    return s.id;
  }

  it('the window prints within the budget in MCP and CLI, and its header counts the block', async () => {
    seedSession(8);
    const mcp = await mcpText('hippo_assemble', { session_id: sid, budget: 250, fresh_tail_count: 1 });
    const cli = block(await hippo(['assemble', sid, '--budget', '250', '--fresh-tail', '1']));
    for (const text of [mcp, cli]) {
      expect(estimateTokens(text)).toBeLessThanOrEqual(250);
      expect(headerTokens(text, /items, (\d+) tokens \(raw=/)).toBe(estimateTokens(text));
      expect(text).toContain('evicted=');
      expect(text).not.toContain('evicted=0');
    }
  });

  it('never evicts the fresh tail, even when the tail alone exceeds the budget', async () => {
    const rows = seedSession(5);
    const r = await assemble(
      { ...ctx, hippoRoot: hippoDir, store: sqliteStore(hippoDir), config: loadConfig(hippoDir) },
      sid,
      { budget: 20, freshTailCount: 2, cost: assembleCost(sid) },
    );
    expect(r.items.map((it) => it.id)).toEqual(rows.slice(3));
    expect(r.evicted).toBe(3);
  });

  it('drill prints within the budget in MCP and CLI', async () => {
    const id = seedSummary(6);
    const mcp = await mcpText('hippo_drill', { summary_id: id, budget: 200 });
    const cli = block(await hippo(['drill', id, '--budget', '200']));
    for (const text of [mcp, cli]) {
      expect(estimateTokens(text)).toBeLessThanOrEqual(200);
      expect(text).toContain(', truncated):');
      expect(text).toContain('m0:');
    }
  });

  it('drill keeps the first child when it alone exceeds the budget', async () => {
    const id = seedSummary(3);
    const r = await drillDown(
      { ...ctx, hippoRoot: hippoDir, store: sqliteStore(hippoDir), config: loadConfig(hippoDir) },
      id,
      { budget: 5, cost: drillCost },
    );
    expect('children' in r && r.children.map((c) => c.content)).toEqual([line(0)]);
  });
});
