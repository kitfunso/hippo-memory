// A token budget bounds the text that reaches the model, on every surface that prints memories.
// Real SQLite stores and the built CLI; the long tags make the printed text cost far more than the content.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadIndex } from '../src/store/index-and-stats.js';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { estimateTokens } from '../src/token-ledger.js';
import { assemble, drillDown, type Context } from '../src/api.js';
import { assembleCost, drillCost } from '../src/context-render.js';
import { handleMcpRequest, type McpResponse } from '../src/mcp/server.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');
const TAGS = [
  'deployment-pipeline-infrastructure-alpha', 'database-migration-rollback-procedure',
  'observability-alerting-runbook-owner', 'incident-review-follow-up-action-item',
  'customer-facing-latency-regression', 'quarterly-reliability-objective-review',
];
const NOTES = 12;
const OVERSIZE = `Zanzibar ferry timetable: ${Array.from({ length: 300 }, (_, i) => `stop${i}`).join(' ')}`;

interface LedgerRow { surface: string; tokens: number }
type McpArgs = Record<string, string | number | boolean>;

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

function hippo(args: string[], input?: string): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HIPPO_HOME: path.join(root, 'global'), HOME: root, USERPROFILE: root,
  };
  for (const k of ['ANTHROPIC_API_KEY', 'HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
  return execFileSync(process.execPath, [HIPPO_JS, ...args], { cwd: root, env, input, encoding: 'utf8' });
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
    return (db.prepare('SELECT surface, tokens FROM token_ledger ORDER BY id').all() as Array<{ surface: string; tokens: number }>)
      .map((r) => ({ surface: String(r.surface), tokens: Number(r.tokens) }));
  } finally {
    closeHippoDb(db);
  }
}

function retrievalCount(id: string): number {
  const db = openHippoDb(hippoDir);
  try {
    // SAFETY: the SELECT names exactly this one column.
    return (db.prepare('SELECT retrieval_count FROM memories WHERE id = ?').get(id) as { retrieval_count: number }).retrieval_count;
  } finally {
    closeHippoDb(db);
  }
}

async function mcpText(name: string, args: McpArgs): Promise<string> {
  const res: McpResponse | null = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { hippoRoot: hippoDir, tenantId: 'default', actor: 'mcp' },
  );
  // SAFETY: tools/call answers carry one MCP text content block.
  return (res?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? '';
}

// Every note matched and printed while the store holds more than the budget can show.
function expectBudgetBinds(text: string): void {
  const shown = shownNotes(text).length;
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(NOTES);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-budget-block-'));
  hippoDir = path.join(root, '.hippo');
  fs.mkdirSync(hippoDir, { recursive: true });
  initStore(hippoDir);
  ids = new Map();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('hippo context', () => {
  it.each([
    ['a query', ['context', 'postgres', 'rollback', '--budget', '400']],
    ['no query', ['context', '--budget', '400']],
  ])('markdown with %s prints within the budget; the header and the ledger count the block', (_label, args) => {
    seedNotes();
    const text = block(hippo(args));
    expect(estimateTokens(text)).toBeLessThanOrEqual(400);
    expect(headerTokens(text, /## Project Memory \(\d+ entries, (\d+) tokens\)/)).toBe(estimateTokens(text));
    expectBudgetBinds(text);
    expect(ledger().at(-1)).toEqual({ surface: 'context', tokens: estimateTokens(text) });
  });

  it('the per-prompt hook fits the budget, and each block header and ledger row counts its own block', () => {
    fs.writeFileSync(path.join(hippoDir, 'config.json'), JSON.stringify({
      pinnedInject: { promptRecall: true, promptRecallThreshold: 0.1, promptRecallMinShared: 1 },
    }));
    seedNotes();
    seed('Pinned rule one: always run the postgres migration dry run before a deploy', { pinned: true });
    seed('Pinned rule two: never drop a column in the same release that stops reading it', { pinned: true });
    const out = hippo(['context', '--pinned-only', '--format', 'additional-context', '--budget', '600'],
      JSON.stringify({ session_id: 'sess-budget', prompt: 'postgres migration rollback plan dry run' }));
    // SAFETY: the hook prints one hookSpecificOutput JSON object.
    const ac = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(estimateTokens(ac)).toBeLessThanOrEqual(600);
    const cut = ac.indexOf('## Prompt-Relevant Memory');
    expect(cut).toBeGreaterThan(0);
    const staticBlock = ac.slice(0, cut - 2);
    const recallBlock = ac.slice(cut);
    expect(headerTokens(staticBlock, /## Project Memory \(\d+ entries, (\d+) tokens\)/)).toBe(estimateTokens(staticBlock));
    expect(headerTokens(recallBlock, /## Prompt-Relevant Memory \(\d+ entries, (\d+) tokens\)/)).toBe(estimateTokens(recallBlock));
    expectBudgetBinds(recallBlock);
    expect(ledger()).toEqual([
      { surface: 'hook', tokens: estimateTokens(staticBlock) },
      { surface: 'hook_recall', tokens: estimateTokens(recallBlock) },
    ]);
  });

  it('an entry the budget leaves out gets no retrieval bump and is not in last_retrieval_ids', () => {
    seedNotes();
    const shown = shownNotes(block(hippo(['context', 'postgres', 'rollback', '--budget', '400']))).map((c) => ids.get(c)!);
    expect(shown.length).toBeLessThan(NOTES);
    for (const id of ids.values()) expect(retrievalCount(id)).toBe(shown.includes(id) ? 1 : 0);
    expect([...loadIndex(hippoDir).last_retrieval_ids].sort()).toEqual([...shown].sort());
  });

  it('skips an entry that alone exceeds the budget and keeps filling, with or without a query', () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    seedNotes({ created: old, last_retrieved: old });
    const big = seed(OVERSIZE);
    const all = block(hippo(['context', '--budget', '400']));
    expect(all).not.toContain('Zanzibar');
    expectBudgetBinds(all);
    expect(hippo(['context', 'zanzibar', 'ferry', '--budget', '400'])).not.toContain('Zanzibar');
    expect(retrievalCount(big)).toBe(0);
  });
});

describe('hippo recall', () => {
  it('prints within the budget; the header and the ledger count the block, and JSON picks the same memories', () => {
    seedNotes();
    const text = block(hippo(['recall', 'postgres rollback', '--budget', '400']));
    expect(estimateTokens(text)).toBeLessThanOrEqual(400);
    expect(headerTokens(text, /Found \d+ memories \((\d+) tokens\)/)).toBe(estimateTokens(text));
    expectBudgetBinds(text);
    expect(ledger().at(-1)).toEqual({ surface: 'recall', tokens: estimateTokens(text) });

    const json = block(hippo(['recall', 'postgres rollback', '--budget', '400', '--json']));
    // SAFETY: recall --json prints { results: [{ content }] }.
    const picked = (JSON.parse(json) as { results: Array<{ content: string }> }).results.map((r) => r.content);
    expect(picked.sort()).toEqual(shownNotes(text).sort());
    expect(ledger().at(-1)).toEqual({ surface: 'recall', tokens: estimateTokens(json) });
  });

  it('an entry the budget leaves out gets no retrieval bump and is not in last_retrieval_ids', () => {
    seedNotes();
    const shown = shownNotes(block(hippo(['recall', 'postgres rollback', '--budget', '400']))).map((c) => ids.get(c)!);
    expect(shown.length).toBeLessThan(NOTES);
    for (const id of ids.values()) expect(retrievalCount(id)).toBe(shown.includes(id) ? 1 : 0);
    expect([...loadIndex(hippoDir).last_retrieval_ids].sort()).toEqual([...shown].sort());
  });

  it('keeps its --min-results floor for an entry larger than the whole budget, and says so in the header', () => {
    seedNotes();
    seed(OVERSIZE);
    const kept = block(hippo(['recall', 'zanzibar ferry', '--budget', '400']));
    expect(kept).toContain('Zanzibar ferry timetable');
    expect(headerTokens(kept, /Found \d+ memories \((\d+) tokens\)/)).toBe(estimateTokens(kept));
    expect(estimateTokens(kept)).toBeGreaterThan(400);
    const floorless = block(hippo(['recall', 'zanzibar ferry', '--budget', '400', '--min-results', '0']));
    expect(floorless).not.toContain('Zanzibar ferry timetable');
    expect(estimateTokens(floorless)).toBeLessThanOrEqual(400);
  });
});

describe('MCP recall and context', () => {
  let cwd: string;
  beforeEach(() => { cwd = process.cwd(); process.chdir(root); }); // hippo_context reads its query from git in the cwd
  afterEach(() => { process.chdir(cwd); });

  it.each([
    ['hippo_recall', 'mcp_recall', { query: 'postgres rollback', budget: 400 }],
    ['hippo_context', 'mcp_context', { budget: 400 }],
  ])('%s returns text within the budget and books that text', async (tool, surface, args) => {
    seedNotes();
    const text = await mcpText(tool, args);
    expect(estimateTokens(text)).toBeLessThanOrEqual(400);
    expectBudgetBinds(text);
    for (const [content, id] of ids) expect(retrievalCount(id)).toBe(text.includes(content) ? 1 : 0);
    expect(ledger().at(-1)).toEqual({ surface, tokens: estimateTokens(text) });
  });
});

describe('assemble and drill', () => {
  const ctx: Context = { hippoRoot: '', tenantId: 'default', actor: { subject: 'test:budget', role: 'admin' } };
  const sid = 'sess-budget-window';
  const line = (i: number): string => `Session message m${i}: ${'the rollback runbook step and its owner '.repeat(5)}`;

  function seedSession(n: number): string[] {
    return Array.from({ length: n }, (_, i) => {
      const e = createMemory(line(i), { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Buffer, kind: 'raw', source_session_id: sid, tags: TAGS });
      e.created = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
      writeEntry(hippoDir, e);
      return e.id;
    });
  }

  function seedSummary(children: number): string {
    const s = createMemory('Rollup of the rollback runbook thread', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Semantic, dag_level: 2, tags: ['dag-summary'] });
    s.descendant_count = children;
    writeEntry(hippoDir, s);
    for (let i = 0; i < children; i++) {
      const c = createMemory(line(i), { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, dag_level: 1, dag_parent_id: s.id, tags: TAGS });
      c.created = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
      writeEntry(hippoDir, c);
    }
    return s.id;
  }

  it('the window prints within the budget in MCP and CLI, and its header counts the block', async () => {
    seedSession(8);
    const mcp = await mcpText('hippo_assemble', { session_id: sid, budget: 250, fresh_tail_count: 1 });
    const cli = block(hippo(['assemble', sid, '--budget', '250', '--fresh-tail', '1']));
    for (const text of [mcp, cli]) {
      expect(estimateTokens(text)).toBeLessThanOrEqual(250);
      expect(headerTokens(text, /items, (\d+) tokens \(raw=/)).toBe(estimateTokens(text));
      expect(text).toContain('evicted=');
      expect(text).not.toContain('evicted=0');
    }
  });

  it('never evicts the fresh tail, even when the tail alone exceeds the budget', () => {
    const rows = seedSession(5);
    const r = assemble({ ...ctx, hippoRoot: hippoDir }, sid, { budget: 20, freshTailCount: 2, cost: assembleCost(sid) });
    expect(r.items.map((it) => it.id)).toEqual(rows.slice(3));
    expect(r.evicted).toBe(3);
  });

  it('drill prints within the budget in MCP and CLI', async () => {
    const id = seedSummary(6);
    const mcp = await mcpText('hippo_drill', { summary_id: id, budget: 200 });
    const cli = block(hippo(['drill', id, '--budget', '200']));
    for (const text of [mcp, cli]) {
      expect(estimateTokens(text)).toBeLessThanOrEqual(200);
      expect(text).toContain(', truncated):');
      expect(text).toContain('m0:');
    }
  });

  it('drill keeps the first child when it alone exceeds the budget', () => {
    const id = seedSummary(3);
    const r = drillDown({ ...ctx, hippoRoot: hippoDir }, id, { budget: 5, cost: drillCost });
    expect('children' in r && r.children.map((c) => c.content)).toEqual([line(0)]);
  });
});
