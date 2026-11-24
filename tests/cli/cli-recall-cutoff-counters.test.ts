import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, afterEach, vi, onTestFinished } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { insertEntityAt, insertRelationAt } from '../_helpers/graph-seed.js';
import { remember } from '../../src/api/index.js';
import { makeEnv, type TestEnv } from '../_helpers/cli-env.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, apiCtx } = sessionPerTest();

async function hippo(cwd: string, globalRoot: string, ...args: string[]): Promise<string> {
  vi.stubEnv('HIPPO_HOME', globalRoot);
  vi.stubEnv('HIPPO_TENANT', 'default');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  const saved = process.cwd();
  process.chdir(cwd);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

function ctxFor(root: string): FullContext {
  return apiCtx(root, 'default', { subject: 'c5-test', role: 'admin' });
}

async function seedMatchingMemories(env: TestEnv, keyword: string, count: number): Promise<void> {
  const ctx = ctxFor(env.hippoRoot);
  for (let i = 0; i < count; i++) {
    await remember(ctx, { content: `${keyword} candidate number ${i} carries unique detail ${i}` });
  }
}

interface SuppressionSummary {
  totalCandidates: number;
  droppedPreRank: number;
  droppedByBudget: number;
}

type RecallJson = { results: unknown[]; suppressionSummary: SuppressionSummary };

async function recallJsonBudget(env: TestEnv, query: string, budget: number): Promise<RecallJson> {
  const raw = await hippo(env.cwd, env.globalRoot, 'recall', query, '--json', '--budget', String(budget));
  return JSON.parse(raw.slice(raw.indexOf('{')));
}

async function recallJson(env: TestEnv, query: string, limit: number): Promise<RecallJson> {
  const raw = await hippo(env.cwd, env.globalRoot, 'recall', query, '--json', '--limit', String(limit));
  return JSON.parse(raw.slice(raw.indexOf('{')));
}

function recallText(env: TestEnv, query: string, limit: number): Promise<string> {
  return hippo(env.cwd, env.globalRoot, 'recall', query, '--why', '--limit', String(limit));
}

describe('printRecall candidate accounting closes', () => {
  let env: TestEnv;

  afterEach(() => {
    vi.unstubAllEnvs();
    const cwd = env?.cwd;
    if (cwd) onTestFinished(() => removeDir(cwd));
  });

  it.each([
    { keyword: 'widgetalpha', seeded: 30, limit: 5 },
    { keyword: 'widgetbeta', seeded: 30, limit: 15 },
    { keyword: 'widgetgamma', seeded: 12, limit: 4 },
  ])(
    'totalCandidates == droppedPreRank + droppedByBudget + returned ($keyword, limit=$limit)',
    async ({ keyword, seeded, limit }) => {
      env = makeEnv(`c5-${keyword}`);
      await seedMatchingMemories(env, keyword, seeded);

      const out = await recallJson(env, keyword, limit);
      const s = out.suppressionSummary;
      const returned = out.results.length;

      expect(s.totalCandidates).toBe(s.droppedPreRank + s.droppedByBudget + returned);
      expect(s.totalCandidates).toBeGreaterThanOrEqual(seeded);
      expect(returned).toBeLessThanOrEqual(limit);
    },
  );

  it('invariant also holds when nothing is truncated (droppedByBudget == 0)', async () => {
    env = makeEnv('c5-notrunc');
    await seedMatchingMemories(env, 'widgetdelta', 5);

    const out = await recallJson(env, 'widgetdelta', 100);
    const s = out.suppressionSummary;
    const returned = out.results.length;

    expect(s.totalCandidates).toBe(s.droppedPreRank + s.droppedByBudget + returned);
    expect(s.droppedByBudget).toBe(0);
  });
});

describe('graph-expanded recall keeps the published accounting honest', () => {
  let home: string;
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a row surfaced by edge is included in the published total and the invariant closes', async () => {
    home = makeRoot('c5-graph', { init: false });
    const root = join(home, '.hippo');
    const globalRoot = join(home, 'global-hippo');
    mkdirSync(globalRoot, { recursive: true });
    initTestStore(root);
    const T = 'default';
    const mk = (text: string) => {
      const m = createMemory(text, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        tags: [],
        layer: Layer.Semantic,
        confidence: 'verified',
        source: 'test',
        tenantId: T,
      });
      writeEntry(root, m, { actor: 'test' });
      return m;
    };
    const a = mk('decision quokka about cache invalidation strategy');
    const b = mk('wholly unrelated wording xyzzy plugh frobnicate');
    const ea = insertEntityAt(root, T, { entityType: 'decision', name: 'A', memoryId: a.id }).id;
    const eb = insertEntityAt(root, T, { entityType: 'decision', name: 'B', memoryId: b.id }).id;
    insertRelationAt(root, T, { fromEntityId: eb, toEntityId: ea, relType: 'supersedes', memoryId: b.id });

    const raw = await hippo(home, globalRoot, 'recall', 'quokka', '--hops', '1', '--json');
    const d = JSON.parse(raw.slice(raw.indexOf('{')));
    const s: SuppressionSummary = d.suppressionSummary;
    const rows: Array<{ entry?: { id: string }; id?: string }> = d.memories ?? d.results ?? [];
    const ids = rows.map((r) => (r.entry ?? r).id);

    expect(ids, 'graph neighbour must be surfaced by edge').toContain(b.id);
    expect(s.totalCandidates, 'published invariant must close when the graph adds an out-of-pool row').toBe(
      s.droppedPreRank + s.droppedByBudget + rows.length,
    );
    expect(s.totalCandidates, 'total must count the edge-surfaced row').toBeGreaterThanOrEqual(rows.length);
  });
});

describe('BUDGET-driven truncation is counted (the measured failure)', () => {
  let env: TestEnv;
  afterEach(() => {
    vi.unstubAllEnvs();
    const cwd = env?.cwd;
    if (cwd) onTestFinished(() => removeDir(cwd));
  });

  it('reports drops when a small --budget truncates and --limit is never passed', async () => {
    env = makeEnv('c5-budget-gap');
    await seedMatchingMemories(env, 'widgetbudget', 40);

    const out = await recallJsonBudget(env, 'widgetbudget', 40);
    const s = out.suppressionSummary;
    const returned = out.results.length;

    expect(returned, 'a small budget must truncate').toBeLessThan(s.totalCandidates);
    expect(returned).toBe(1);
    expect(s.totalCandidates).toBe(40);
    expect(s.droppedByBudget, 'budget/rank drops must be counted - this read 0 in production').toBe(39);
    expect(s.totalCandidates, 'published invariant must close on the budget path too').toBe(
      s.droppedPreRank + s.droppedByBudget + returned,
    );
  });
});

describe('the `Cutoff:` line prints on a truncated CLI recall', () => {
  let env: TestEnv;

  afterEach(() => {
    vi.unstubAllEnvs();
    const cwd = env?.cwd;
    if (cwd) onTestFinished(() => removeDir(cwd));
  });

  it('prints "Cutoff:" naming the dropped count when --limit truncates the result set', async () => {
    env = makeEnv('c5-print-gap');
    await seedMatchingMemories(env, 'widgetepsilon', 30);

    const output = await recallText(env, 'widgetepsilon', 5);

    expect(output).toMatch(/^Cutoff: showing \d+ of \d+ candidates;/m);
    expect(output).toMatch(/not shown \(rank, budget or limit\)/);
    expect(output, 'must not name a control the caller may never have passed').not.toMatch(/dropped to fit limit/);
  });

  it('does NOT print "Cutoff:" when the recall is not truncated (no always-on noise)', async () => {
    env = makeEnv('c5-no-print');
    await seedMatchingMemories(env, 'widgetzeta', 3);

    const output = await recallText(env, 'widgetzeta', 100);

    expect(output).not.toMatch(/^Cutoff:/m);
  });
});
