// tests/c5-cli-cutoff-counters.test.ts
//
// C5 (2026-08-24 follow-up, episode 01M0SB83EW4JF1RCFC1GAWTAQN): the CLI
// `hippo recall` path dropped almost every candidate and reported it via
// counters that never moved. `droppedByBudgetCountCmd` was computed from
// `results.length - limit` (src/cli.ts) AFTER the search call, but `results`
// had already been ranked and truncated by hybridSearch/physicsSearch, so
// the counter read 0 while hundreds of candidates silently vanished. The
// `Cutoff:` line (guarded on `clauses.length > 0`) never printed as a result.
//
// This suite asserts the fix at the level the plan's acceptance criteria
// name:
//   1. The invariant `totalCandidates == droppedPreRank + droppedByBudget +
//      returned` holds across several --limit/query combinations, driven
//      through the real CLI subprocess against a real seeded store.
//   2. The `Cutoff:` line actually PRINTS in CLI text output when a recall
//      is truncated (the specific gap: no prior test drove the CLI summary
//      output at all).
//   3. The line does NOT print when nothing was truncated (guard against
//      always-on noise).
//
// Same isolation harness as tests/b3-retrieval-policy.test.ts: per-test cwd
// tempdir, separate HIPPO_HOME global root, HIPPO_SKIP_AUTO_INTEGRATIONS=1,
// initStore + api.remember for seeding, execFileSync against dist/src/cli.js
// for the recall itself (real DB, real CLI, project convention).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { insertEntity, insertRelation } from '../src/graph.js';
import { remember, type Context } from '../src/api.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface TestEnv {
  cwd: string;
  hippoRoot: string;
  globalRoot: string;
}

function makeEnv(prefix: string): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), `hippo-c5-${prefix}-`));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  return { cwd, hippoRoot, globalRoot };
}

function ctxFor(root: string): Context {
  return { hippoRoot: root, tenantId: 'default', actor: { subject: 'c5-test', role: 'admin' } };
}

/** Seed `count` distinct memories that all match `keyword`. */
function seedMatchingMemories(env: TestEnv, keyword: string, count: number): void {
  const ctx = ctxFor(env.hippoRoot);
  for (let i = 0; i < count; i++) {
    remember(ctx, { content: `${keyword} candidate number ${i} carries unique detail ${i}` });
  }
}

interface SuppressionSummary {
  totalCandidates: number;
  droppedPreRank: number;
  droppedByBudget: number;
}

function recallJsonBudget(
  env: TestEnv,
  query: string,
  budget: number,
): { results: unknown[]; suppressionSummary: SuppressionSummary } {
  const raw = execFileSync(
    'node',
    [CLI, 'recall', query, '--json', '--budget', String(budget)],
    {
      cwd: env.cwd,
      env: {
        ...process.env,
        HIPPO_HOME: env.globalRoot,
        HIPPO_TENANT: 'default',
        HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
      },
      encoding: 'utf8',
    },
  );
  const start = raw.indexOf('{');
  return JSON.parse(raw.slice(start));
}

function recallJson(
  env: TestEnv,
  query: string,
  limit: number,
): { results: unknown[]; suppressionSummary: SuppressionSummary } {
  const raw = execFileSync(
    'node',
    [CLI, 'recall', query, '--json', '--limit', String(limit)],
    {
      cwd: env.cwd,
      env: {
        ...process.env,
        HIPPO_HOME: env.globalRoot,
        HIPPO_TENANT: 'default',
        HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
      },
      encoding: 'utf8',
    },
  );
  const start = raw.indexOf('{');
  return JSON.parse(raw.slice(start));
}

function recallText(env: TestEnv, query: string, limit: number): string {
  return execFileSync(
    'node',
    [CLI, 'recall', query, '--why', '--limit', String(limit)],
    {
      cwd: env.cwd,
      env: {
        ...process.env,
        HIPPO_HOME: env.globalRoot,
        HIPPO_TENANT: 'default',
        HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
      },
      encoding: 'utf8',
    },
  );
}

describe('C5: cmdRecall candidate accounting closes (2026-08-24)', () => {
  let env: TestEnv;

  afterEach(() => {
    if (env?.cwd) rmSync(env.cwd, { recursive: true, force: true });
  });

  it.each([
    { keyword: 'widgetalpha', seeded: 30, limit: 5 },
    { keyword: 'widgetbeta', seeded: 30, limit: 15 },
    { keyword: 'widgetgamma', seeded: 12, limit: 4 },
  ])(
    'totalCandidates == droppedPreRank + droppedByBudget + returned ($keyword, limit=$limit)',
    ({ keyword, seeded, limit }) => {
      env = makeEnv(keyword);
      seedMatchingMemories(env, keyword, seeded);

      const out = recallJson(env, keyword, limit);
      const s = out.suppressionSummary;
      const returned = out.results.length;

      expect(s.totalCandidates).toBe(s.droppedPreRank + s.droppedByBudget + returned);
      // Sanity: the invariant should not be trivially true by everything
      // being zero — this recall must actually have candidates and a cut.
      expect(s.totalCandidates).toBeGreaterThanOrEqual(seeded);
      expect(returned).toBeLessThanOrEqual(limit);
    },
  );

  it('invariant also holds when nothing is truncated (droppedByBudget == 0)', () => {
    env = makeEnv('notrunc');
    seedMatchingMemories(env, 'widgetdelta', 5);

    const out = recallJson(env, 'widgetdelta', 100);
    const s = out.suppressionSummary;
    const returned = out.results.length;

    expect(s.totalCandidates).toBe(s.droppedPreRank + s.droppedByBudget + returned);
    expect(s.droppedByBudget).toBe(0);
  });
});



describe('C5: graph-expanded recall keeps the published accounting honest', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  // The graph fix has to be proven by EXECUTION, with a real edge. Two
  // earlier attempts to verify it used fixtures with no entity relations, so
  // the hops path added nothing and the checks were vacuous. This seeds the
  // same shape as tests/graph-recall.test.ts: B is lexically orthogonal to
  // the query and reachable only through a supersedes edge.
  it('a row surfaced by edge is included in the published total and the invariant closes', () => {
    // Same root convention as makeEnv: the store ROOT is the .hippo directory
    // itself. initStore(home) with a bare dir leaves cwd/.hippo uninitialized
    // and the CLI exits "No .hippo directory found".
    home = mkdtempSync(join(tmpdir(), 'c5-graph-'));
    const root = join(home, '.hippo');
    const globalRoot = join(home, 'global-hippo');
    mkdirSync(globalRoot, { recursive: true });
    initStore(root);
    const T = 'default';
    const mk = (text: string) => {
      const m = createMemory(text, {
        tags: [], layer: Layer.Semantic, confidence: 'verified', source: 'test', tenantId: T,
      });
      writeEntry(root, m, { actor: 'test' });
      return m;
    };
    const a = mk('decision quokka about cache invalidation strategy');
    const b = mk('wholly unrelated wording xyzzy plugh frobnicate');
    const ea = insertEntity(root, T, { entityType: 'decision', name: 'A', memoryId: a.id }).id;
    const eb = insertEntity(root, T, { entityType: 'decision', name: 'B', memoryId: b.id }).id;
    insertRelation(root, T, { fromEntityId: eb, toEntityId: ea, relType: 'supersedes', memoryId: b.id });

    // cwd is `home` so no stray local store joins the recall: this test pins
    // the SINGLE-store graph case. (A worktree cwd would silently merge its
    // local .hippo - remember() writes to cwd/.hippo, HIPPO_HOME only moves
    // the global store. That exact confusion made two earlier probes invalid.)
    const raw = execFileSync(
      'node',
      [CLI, 'recall', 'quokka', '--hops', '1', '--json'],
      {
        cwd: home,
        env: { ...process.env, HIPPO_HOME: globalRoot, HIPPO_TENANT: T, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
        encoding: 'utf8',
      },
    );
    const d = JSON.parse(raw.slice(raw.indexOf('{')));
    const s = d.suppressionSummary as SuppressionSummary;
    const rows = (d.memories ?? d.results ?? []) as Array<{ entry?: { id: string }; id?: string }>;
    const ids = rows.map((r) => (r.entry ?? r).id);

    // the edge must actually fire, or this test proves nothing
    expect(ids, 'graph neighbour must be surfaced by edge').toContain(b.id);
    // the graph-added row must be inside the PUBLISHED total, not only the
    // internal arithmetic - this is what broke: total said 1, returned said 2
    expect(
      s.totalCandidates,
      'published invariant must close when the graph adds an out-of-pool row',
    ).toBe(s.droppedPreRank + s.droppedByBudget + rows.length);
    expect(s.totalCandidates, 'total must count the edge-surfaced row').toBeGreaterThanOrEqual(rows.length);
  });
});

describe('C5: BUDGET-driven truncation is counted (the measured failure)', () => {
  let env: TestEnv;
  afterEach(() => {
    if (env?.cwd) rmSync(env.cwd, { recursive: true, force: true });
  });

  // THE GAP THIS FILE ORIGINALLY MISSED. Every other test here passes
  // --limit, and the OLD code counted the --limit slice correctly, so those
  // tests pass on master and prove only that the wording changed.
  //
  // The measured production failure was budget/rank driven with NO --limit:
  // totalCandidates 400, returned 3, droppedByBudget 0, Cutoff line silent.
  // This is the case that must go red without the derivation fix.
  it('reports drops when a small --budget truncates and --limit is never passed', () => {
    env = makeEnv('budget-gap');
    seedMatchingMemories(env, 'widgetbudget', 40);

    const out = recallJsonBudget(env, 'widgetbudget', 40);
    const s = out.suppressionSummary;
    const returned = out.results.length;

    expect(returned, 'a small budget must truncate').toBeLessThan(s.totalCandidates);
    expect(
      s.droppedByBudget,
      'budget/rank drops must be counted - this read 0 in production',
    ).toBeGreaterThan(0);
    expect(
      s.totalCandidates,
      'published invariant must close on the budget path too',
    ).toBe(s.droppedPreRank + s.droppedByBudget + returned);
  });
});

describe('C5: the `Cutoff:` line prints on a truncated CLI recall (2026-08-24)', () => {
  let env: TestEnv;

  afterEach(() => {
    if (env?.cwd) rmSync(env.cwd, { recursive: true, force: true });
  });

  it('prints "Cutoff:" naming the dropped count when --limit truncates the result set', () => {
    env = makeEnv('print-gap');
    seedMatchingMemories(env, 'widgetepsilon', 30);

    const output = recallText(env, 'widgetepsilon', 5);

    // This is the specific gap the plan names: no prior test drove the CLI
    // summary output, so the line's guard (`clauses.length > 0`) being
    // permanently false went uncaught.
    //
    // The wording is asserted deliberately. It used to read "dropped to fit
    // limit", which named a control the caller often never passed - review
    // caught it printing that for a `--budget 20` command with no --limit
    // flag at all. The residual covers rank, budget AND limit, so the text
    // must not single one out.
    expect(output).toMatch(/^Cutoff: showing \d+ of \d+ candidates;/m);
    expect(output).toMatch(/not shown \(rank, budget or limit\)/);
    expect(output, 'must not name a control the caller may never have passed')
      .not.toMatch(/dropped to fit limit/);
  });

  it('does NOT print "Cutoff:" when the recall is not truncated (no always-on noise)', () => {
    env = makeEnv('no-print');
    seedMatchingMemories(env, 'widgetzeta', 3);

    const output = recallText(env, 'widgetzeta', 100);

    expect(output).not.toMatch(/^Cutoff:/m);
  });
});
