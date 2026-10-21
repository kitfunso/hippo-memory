// A7 recall-trace: CLI `recall --why` on a hero memory that fires every CLI-drivable rerank stage, so its trace is the
// full ordered chain. No-trace default output and the `--goal` stage are pinned in tests/cli/cli-recall-golden.process.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { pushGoal, writeEntry } from '../_helpers/root-forms.js';

/** `hippo <args>` run in this process from `cwd`, the call bin/hippo.js makes; a non-zero exit fails the test. */
async function hippo(cwd: string, ...args: string[]): Promise<string> {
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

describe('recall --why rerankTrace', () => {
  let home: string;
  const tenantId = 'default';
  const sessionId = 'sess-a7-cli';
  let heroId: string;
  let peerId: string;
  const WHY_ARGS = [
    'recall',
    'auth',
    '--why',
    '--filter-conflicts',
    '--value-aware',
    '--rerank-utility',
    '--salience-threshold',
    '5',
    '--limit',
    '10',
  ];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-a7-cli-'));
    const localRoot = join(home, '.hippo');
    vi.stubEnv('HIPPO_HOME', join(home, 'global-hippo'));
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    await hippo(home, 'init', '--no-hooks', '--no-schedule', '--no-learn');

    // peer: matches the query and is referenced by the hero's conflicts_with,
    // so --filter-conflicts fires the interference stage on the hero.
    const peer = createMemory('auth token refresh peer', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['ui'],
      tenantId,
    });
    writeEntry(localRoot, peer);
    peerId = peer.id;

    // hero: qualifies for value (outcomes set), utility (always), goal-boost
    // (goal-tagged + active goal), retrieval-count-downweight (low count), and
    // interference (conflicts_with references the peer, also in results).
    const hero = createMemory('auth token refresh hero details', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['fix-auth'],
      tenantId,
    });
    hero.conflictsWith = [peer.id];
    hero.outcomePositive = 3;
    hero.outcomeNegative = 0;
    hero.retrievalCount = 1; // below the --salience-threshold below
    heroId = hero.id;
    writeEntry(localRoot, hero);

    pushGoal(localRoot, { sessionId, tenantId, goalName: 'fix-auth' });
    vi.stubEnv('HIPPO_SESSION_ID', sessionId);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('text --why renders the ordered, contiguous ranking chain on the hero', async () => {
    const out = await hippo(home, ...WHY_ARGS);
    const lines = out.split('\n');
    const rankingLine = lines.find((l) => l.trim().startsWith('ranking:'));
    expect(rankingLine?.trim(), `no ranking line in output:\n${out}`).toMatch(/^ranking:/);

    // Fired stages must appear in pipeline order within the chain.
    const order = ['interference', 'value', 'utility', 'goal-boost', 'retrieval-count-downweight'];
    const positions = order.map((stage) => rankingLine!.indexOf(stage));
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it('JSON --why includes rerankTrace on the hero item, contiguous chain', async () => {
    const out = await hippo(home, ...WHY_ARGS, '--json');
    // SAFETY: `recall --json` output is written by this CLI's own JSON
    // formatter, which always emits `results[].id` and, under `--why`, a
    // `rerankTrace` array of `{stage, scoreBefore, scoreAfter}` steps.
    const parsed = JSON.parse(out) as {
      results: Array<{ id: string; rerankTrace?: Array<{ stage: string; scoreBefore: number; scoreAfter: number }> }>;
    };
    const hero = parsed.results.find((r) => r.id === heroId);
    expect(hero?.id, `hero not in results:\n${out}`).toBe(heroId);
    const trace = hero!.rerankTrace!;
    expect(trace.map((s) => s.stage)).toEqual([
      'interference',
      'value',
      'utility',
      'goal-boost',
      'retrieval-count-downweight',
    ]);
    // Contiguous chain: each step's scoreBefore == prior step's scoreAfter.
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i].scoreBefore).toBe(trace[i - 1].scoreAfter);
    }
  });

  it('a bare --salience-threshold reads as 1, so only the never-recalled peer is downweighted', async () => {
    const out = await hippo(home, 'recall', 'auth', '--why', '--json', '--salience-threshold');
    // SAFETY: the same `recall --json --why` shape the test above reads.
    const parsed = JSON.parse(out) as { results: Array<{ id: string; rerankTrace?: Array<{ stage: string }> }> };
    const stages = (id: string): string[] =>
      (parsed.results.find((r) => r.id === id)?.rerankTrace ?? []).map((s) => s.stage);
    expect(stages(peerId)).toContain('retrieval-count-downweight');
    expect(stages(heroId)).not.toContain('retrieval-count-downweight');
  });
});
