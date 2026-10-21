// What the whole-store MCP tools return on a small fixed store: which rows they show and the counts they print.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../../src/surface/mcp/server.js';
import { withSharedStoreHandles } from '../../src/db/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { testReach } from '../_helpers/api-ctx.js';
import { loadConfig } from '../../src/base/config/config.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { testInfra } from '../_helpers/infra.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], {
      cwd: dir,
      stdio: 'ignore',
    });
  };
  git('init', '-q');
  for (const subject of [...COMMIT_SUBJECTS].reverse()) git('commit', '-q', '--allow-empty', '-m', subject);
}

const NOW = '2026-06-01T00:00:00.000Z';
const WORDS = [
  'cache',
  'deploy',
  'kafka',
  'redis',
  'merge',
  'lint',
  'schema',
  'queue',
  'retry',
  'backup',
  'token',
  'hook',
];
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
    emotionalValence: i % 9 === 0 ? 'negative' : 'neutral',
    scope: i % 17 === 3 ? 'slack:private:c1' : i % 19 === 4 ? 'unknown:legacy' : i % 13 === 5 ? 'team:x' : null,
    tenantId: i % 15 === 14 ? 'acme' : 'default',
  });
  return {
    ...entry,
    id: `ctx-${String(i).padStart(3, '0')}`,
    created: iso(created),
    validFrom: iso(created),
    lastRetrieved: iso(created + (i % 5) * DAY),
    halfLifeDays: [3, 7, 30, 90][i % 4],
    retrievalCount: i % 6,
    outcomePositive: i % 7 === 0 ? 2 : 0,
    outcomeNegative: i % 11 === 0 ? 1 : 0,
    supersededBy: i % 31 === 7 ? 'ctx-000' : null,
    originProject: i % 10 === 1 ? 'other' : i % 10 === 2 ? '' : i % 23 === 6 ? null : 'proj',
  };
}

function globalRow(j: number): MemoryEntry {
  const source =
    j % 3 === 0 ? `shared:proj${j % 4}:x` : j % 3 === 1 ? '/tmp/projB/.hippo' : j % 5 === 0 ? 'cli-global' : 'cli';
  // Pairs share a timestamp so peer order and rank ties fall to the id.
  const created = base - Math.floor(j / 2) * 13 * HOUR;
  const entry = createMemory(
    `global note ${j} on ${WORDS[j % WORDS.length]} for the ${WORDS[(j * 5) % WORDS.length]} team`,
    {
      source: source.startsWith('/') ? `promoted:${source}` : source,
      pinned: j % 17 === 0,
      tenantId: j % 7 === 6 ? 'acme' : 'default',
    },
  );
  return {
    ...entry,
    id: `glob-${String(j).padStart(3, '0')}`,
    created: iso(created),
    validFrom: iso(created),
    lastRetrieved: iso(created),
    halfLifeDays: [7, 30][j % 2],
    originProject: j % 2 === 0 ? 'proj' : '',
  };
}

function merged(): MemoryEntry {
  const held = ['the loader must handle a null cache key before it reads the\nindex file', 'the loader retries twice'];
  const entry = createMemory(mergedText('Two related fixes', held), {
    source: 'consolidation',
    tenantId: 'default',
  });
  return {
    ...entry,
    id: 'ctx-merged',
    created: iso(base - 2 * DAY),
    lastRetrieved: iso(base - 2 * DAY),
    originProject: 'proj',
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

  beforeEach(async () => {
    tmp = makeRoot('request-snapshot', { init: false });
    localRoot = join(tmp, 'proj', '.hippo');
    const globalRoot = join(tmp, 'global');
    mkdirSync(join(tmp, 'proj'), { recursive: true });
    vi.stubEnv('HIPPO_HOME', globalRoot);
    vi.stubEnv('HIPPO_FAKE_NOW', NOW);
    initTestStore(localRoot);
    initTestStore(globalRoot);
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
  });

  const mcpCtx = (): McpContext => {
    const store = sqliteStore(localRoot);
    return {
      hippoRoot: localRoot,
      tenantId: 'default',
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store,
      reach: testReach(localRoot, store),
      config: loadConfig(localRoot),
      infra: testInfra(),
    };
  };
  type ToolArgs = { scope?: string };
  const call = (name: string, args: ToolArgs = {}): Promise<McpResponse | null> =>
    handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, mcpCtx());

  /** The first content line of each row hippo_context prints, in print order. */
  const blocks = (text: string): string[] =>
    text
      .split(/\n\n(?=\[verified\])/)
      .slice(1)
      .map((block) => block.split('\n')[1]!);
  const firstLines = (entries: readonly MemoryEntry[]): string[] =>
    entries.map((e) => e.content.split('\n')[0]!).sort();

  // Shown: the caller's tenant, this project or no project, live, and outside a private or unknown scope.
  const shownLocal = (e: MemoryEntry): boolean =>
    e.tenantId === 'default' &&
    e.supersededBy === null &&
    (e.originProject === 'proj' || e.originProject === '') &&
    e.scope !== 'unknown:legacy' &&
    !(e.scope ?? '').includes(':private:');
  const LOCAL = Array.from({ length: 80 }, (_, i) => localRow(i));
  const GLOBAL = Array.from({ length: 40 }, (_, j) => globalRow(j));

  it('mcp hippo_context shows every eligible row of both stores, and a scope keeps only its own rows', async () => {
    const all = textOf(await call('hippo_context'));
    const shown = [...LOCAL.filter(shownLocal), merged(), ...GLOBAL.filter((e) => e.tenantId === 'default')];
    expect(shown).toHaveLength(91);
    expect(all.split('\n')[0]).toBe('Found 91 memories:');
    expect(blocks(all).sort()).toEqual(firstLines(shown));
    expect(all).toContain(
      '[verified] (strength=1.00)\nTwo related fixes\n\n- the loader must handle a null cache key before it reads the\n' +
        '  index file\n- the loader retries twice\n',
    );
    const scoped = textOf(await call('hippo_context', { scope: 'team:x' }));
    const teamX = LOCAL.filter((e) => shownLocal(e) && e.scope === 'team:x');
    expect(scoped.split('\n')[0]).toBe('Found 4 memories:');
    expect(blocks(scoped).sort()).toEqual(firstLines(teamX));
  });

  it('mcp hippo_status counts the local rows of the caller tenant, and hippo_peers groups global rows by source', async () => {
    // 80 rows and the merged one, less the 5 of tenant acme; pinned every 25th row, an error tag every 8th.
    expect(textOf(await call('hippo_status'))).toBe(
      'Memories: 76 (4 pinned, 10 errors)\nAvg strength: 0.62\nAt risk (<0.2): 19\nOpen conflicts: 0\n' +
        'Half-life default: 365d',
    );
    expect(textOf(await call('hippo_peers')).split('\n')).toEqual([
      'projB: 11 memories (latest: 2026-06-01)',
      'unknown: 10 memories (latest: 2026-05-31)',
      'proj0: 4 memories (latest: 2026-06-01)',
      'proj3: 3 memories (latest: 2026-05-31)',
      'proj1: 3 memories (latest: 2026-05-29)',
      'global-cli: 2 memories (latest: 2026-05-30)',
      'proj2: 2 memories (latest: 2026-05-27)',
    ]);
  });

  it('mcp hippo_learn skips texts the store already holds, including inside a merged row', async () => {
    const repo = join(tmp, 'repo');
    gitRepoWithCommits(repo);
    process.chdir(repo);
    const before = new Set(loadAllEntries(localRoot, 'default').map((e) => e.id));
    const out = textOf(await call('hippo_learn'));
    const added = loadAllEntries(localRoot, 'default')
      .filter((e) => !before.has(e.id))
      .map((e) => e.content)
      .sort();
    // Two of the four subjects are already held: one as a row, one inside the merged row's text.
    expect(out).toBe('Git learn: 2 new, 2 duplicates skipped (scanned 7 days)');
    expect(added).toEqual([
      'bump the redis client to the next minor',
      'refresh the token before the queue worker retries',
    ]);
  });
});
