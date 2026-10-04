// Pins what getContext and the whole-store MCP tools return on a small fixed store, so bounding their loads cannot move it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { Layer, type MemoryEntry } from '../src/memory.js';
import { mergedText } from '../src/same-text.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { getContext, adminActor, type ContextOpts, type ContextResult } from '../src/api.js';
import type { AmbientState } from '../src/ambient.js';
import { handleMcpRequest, type McpResponse } from '../src/mcp/server.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import { withSharedStoreHandles } from '../src/db.js';

// Newest first, as git log prints them.
const COMMIT_SUBJECTS = [
  'fix: the loader must handle a null cache key before it reads the index file',
  'fix(auth): refresh the token before the queue worker retries',
  'fix: fixture 4 note about merge and   cache with the retry step',
  'chore: bump the redis client to the next minor',
];

function gitRepoWithCommits(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  for (const subject of [...COMMIT_SUBJECTS].reverse()) git('commit', '-q', '--allow-empty', '-m', subject);
}

const NOW = '2026-06-01T00:00:00.000Z';
const WORDS = ['cache', 'deploy', 'kafka', 'redis', 'merge', 'lint', 'schema', 'queue', 'retry', 'backup', 'token', 'hook'];
const HOUR = 3600000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();
const base = Date.parse(NOW);

function localRow(i: number): MemoryEntry {
  const w = (k: number): string => WORDS[(i * k) % WORDS.length];
  const created = base - (i + 1) * 9 * HOUR;
  const entry = createMemory(`fixture ${i} note about ${w(1)} and ${w(3)} with the ${w(5)} step`, {
    layer: i % 3 === 0 ? Layer.Semantic : Layer.Episodic,
    tags: i % 8 === 0 ? ['error'] : i % 29 === 9 ? ['secret'] : [`t${i % 4}`],
    pinned: i % 25 === 0,
    emotional_valence: i % 9 === 0 ? 'negative' : 'neutral',
    scope: i % 17 === 3 ? 'slack:private:c1' : i % 19 === 4 ? 'unknown:legacy' : i % 13 === 5 ? 'team:x' : null,
    tenantId: i % 15 === 14 ? 'acme' : 'default',
  });
  return {
    ...entry,
    id: `ctx-${String(i).padStart(3, '0')}`,
    created: iso(created),
    valid_from: iso(created),
    last_retrieved: iso(created + (i % 5) * DAY),
    half_life_days: [3, 7, 30, 90][i % 4],
    retrieval_count: i % 6,
    outcome_positive: i % 7 === 0 ? 2 : 0,
    outcome_negative: i % 11 === 0 ? 1 : 0,
    superseded_by: i % 31 === 7 ? 'ctx-000' : null,
    origin_project: i % 10 === 1 ? 'other' : i % 10 === 2 ? '' : i % 23 === 6 ? null : 'proj',
  };
}

function globalRow(j: number): MemoryEntry {
  const source = j % 3 === 0 ? `shared:proj${j % 4}:x` : j % 3 === 1 ? '/tmp/projB/.hippo' : j % 5 === 0 ? 'cli-global' : 'cli';
  // Pairs share a timestamp so peer order and rank ties fall to the id.
  const created = base - Math.floor(j / 2) * 13 * HOUR;
  const entry = createMemory(`global note ${j} on ${WORDS[j % WORDS.length]} for the ${WORDS[(j * 5) % WORDS.length]} team`, {
    source: source.startsWith('/') ? `promoted:${source}` : source,
    pinned: j % 17 === 0,
    tenantId: j % 7 === 6 ? 'acme' : 'default',
  });
  return {
    ...entry,
    id: `glob-${String(j).padStart(3, '0')}`,
    created: iso(created),
    valid_from: iso(created),
    last_retrieved: iso(created),
    half_life_days: [7, 30][j % 2],
    origin_project: j % 2 === 0 ? 'proj' : '',
  };
}

function merged(): MemoryEntry {
  const held = ['the loader must handle a null cache key before it reads the\nindex file', 'the loader retries twice'];
  const entry = createMemory(mergedText('Two related fixes', held), {
    source: 'consolidation',
    tenantId: 'default',
  });
  return { ...entry, id: 'ctx-merged', created: iso(base - 2 * DAY), last_retrieved: iso(base - 2 * DAY), origin_project: 'proj' };
}

const round = (n: number): number => Math.round(n * 1e9) / 1e9;

interface ContextSnapshot {
  tokens: number;
  entries: Array<{ id: string; score: number; tokens: number; isGlobal: boolean; category: ContextResult['entries'][number]['category']; retrieval_count: number }>;
  ambientState?: AmbientState;
}

function roundedState(state: AmbientState): AmbientState {
  const out = { ...state };
  // SAFETY: out is a spread copy of an AmbientState, so its own keys are AmbientState's keys.
  for (const key of Object.keys(out) as Array<keyof AmbientState>) out[key] = round(out[key]);
  return out;
}

function contextSnapshot(result: ContextResult): ContextSnapshot {
  return {
    tokens: result.tokens,
    entries: result.entries.map((r) => ({
      id: r.entry.id,
      score: round(r.score),
      tokens: r.tokens,
      isGlobal: r.isGlobal ?? false,
      category: r.category,
      retrieval_count: r.entry.retrieval_count,
    })),
    ambientState: result.ambientState ? roundedState(result.ambientState) : undefined,
  };
}

function textOf(res: McpResponse | null): string {
  // SAFETY: these tools answer with one MCP text content block.
  const result = res?.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? '';
}

describe('request-path output on a fixed store', () => {
  let tmp: string;
  let localRoot: string;
  let cwd: string;
  const saved = { home: process.env.HIPPO_HOME, now: process.env.HIPPO_FAKE_NOW };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'hippo-request-snapshot-'));
    localRoot = join(tmp, 'proj', '.hippo');
    const globalRoot = join(tmp, 'global');
    mkdirSync(join(tmp, 'proj'), { recursive: true });
    process.env.HIPPO_HOME = globalRoot;
    process.env.HIPPO_FAKE_NOW = NOW;
    _resetAblationCacheForTests();
    initStore(localRoot);
    initStore(globalRoot);
    await withSharedStoreHandles(() => {
      for (let i = 0; i < 80; i++) writeEntry(localRoot, localRow(i));
      writeEntry(localRoot, merged());
      for (let j = 0; j < 40; j++) writeEntry(globalRoot, globalRow(j));
    });
    cwd = process.cwd();
    process.chdir(tmp); // outside git, so hippo_context's auto query is empty
  });

  afterEach(() => {
    process.chdir(cwd);
    process.env.HIPPO_HOME = saved.home;
    if (saved.now === undefined) delete process.env.HIPPO_FAKE_NOW;
    else process.env.HIPPO_FAKE_NOW = saved.now;
    _resetAblationCacheForTests();
    rmSync(tmp, { recursive: true, force: true });
  });

  const ctx = (): Parameters<typeof getContext>[0] => ({ hippoRoot: localRoot, tenantId: 'default', actor: adminActor('test') });
  const contextCases: Array<[string, ContextOpts]> = [
    ['no query', { currentProject: 'proj' }],
    ['no query, small budget', { currentProject: 'proj', budget: 60 }],
    ['no query, cross-project', { currentProject: 'proj', crossProject: true }],
    ['no query, exact scope', { currentProject: 'proj', exactScope: 'team:x' }],
    ['no query, outside a project', { currentProject: '' }],
    ['no query, limit 5', { currentProject: 'proj', limit: 5 }],
    ['query', { currentProject: 'proj', q: 'kafka redis' }],
    ['pinned only with recent', { currentProject: 'proj', pinnedOnly: true, includeRecent: 4 }],
  ];

  it.each(contextCases)('getContext: %s', async (_label, opts) => {
    expect(contextSnapshot(await getContext(ctx(), opts))).toMatchSnapshot();
  });

  it('getContext: local-only query searches the whole local store', async () => {
    process.env.HIPPO_HOME = join(tmp, 'no-global');
    expect(contextSnapshot(await getContext(ctx(), { currentProject: 'proj', q: 'kafka redis' }))).toMatchSnapshot();
  });

  type ToolArgs = { scope?: string };
  const call = (name: string, args: ToolArgs = {}): Promise<McpResponse | null> =>
    handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      { hippoRoot: localRoot, tenantId: 'default', actor: 'mcp' },
    );

  const toolCases: Array<[string, ToolArgs]> = [
    ['hippo_context', {}],
    ['hippo_context', { scope: 'team:x' }],
    ['hippo_status', {}],
    ['hippo_peers', {}],
  ];
  it.each(toolCases)('mcp %s %j', async (name, args) => {
    expect(textOf(await call(name, args))).toMatchSnapshot();
  });

  it('mcp hippo_learn skips texts the store already holds, including inside a merged row', async () => {
    const repo = join(tmp, 'repo');
    gitRepoWithCommits(repo);
    process.chdir(repo);
    const before = new Set(loadAllEntries(localRoot).map((e) => e.id));
    const out = textOf(await call('hippo_learn'));
    const added = loadAllEntries(localRoot).filter((e) => !before.has(e.id)).map((e) => e.content).sort();
    expect({ out, added }).toMatchSnapshot();
  });
});
