/**
 * A7 recall-trace — CLI `recall --why`.
 *
 * Drives the real `bin/hippo.js` against a real SQLite store. A single "hero"
 * memory is engineered to qualify for every CLI-drivable lifecycle stage so
 * its rerankTrace is the full ordered chain. Asserts:
 *  - text --why: each fired stage appears IN ORDER and the chain is contiguous
 *    (each step's scoreBefore == prior step's scoreAfter).
 *  - JSON --why: rerankTrace present per item.
 *  - backward-compat: default recall (no --why) carries no trace + output is
 *    free of any ranking/rerankTrace markers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { pushGoal } from '../src/goals.js';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');

function hippo(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('node', [HIPPO_BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
}

describe('A7 recall --why rerankTrace', () => {
  let home: string;
  let localRoot: string;
  let env: Record<string, string>;
  const tenantId = 'default';
  const sessionId = 'sess-a7-cli';
  let heroId: string;
  let peerId: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-a7-cli-'));
    localRoot = join(home, '.hippo');
    env = {
      HIPPO_HOME: join(home, 'global-hippo'),
      HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');

    // peer: matches the query and is referenced by the hero's conflicts_with,
    // so --filter-conflicts fires the interference stage on the hero.
    const peer = createMemory('auth token refresh peer', { tags: ['ui'], tenantId });
    peerId = peer.id;
    writeEntry(localRoot, peer);

    // hero: qualifies for value (outcomes set), utility (always), goal-boost
    // (goal-tagged + active goal), retrieval-count-downweight (low count), and
    // interference (conflicts_with references the peer, also in results).
    const hero = createMemory('auth token refresh hero details', {
      tags: ['fix-auth'],
      tenantId,
    });
    hero.conflicts_with = [peerId];
    hero.outcome_positive = 3;
    hero.outcome_negative = 0;
    hero.retrieval_count = 1; // below the --salience-threshold below
    heroId = hero.id;
    writeEntry(localRoot, hero);

    pushGoal(localRoot, { sessionId, tenantId, goalName: 'fix-auth' });
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  function recallWhyText(): string {
    return hippo(
      home,
      { ...env, HIPPO_SESSION_ID: sessionId },
      'recall', 'auth',
      '--why',
      '--filter-conflicts',
      '--value-aware',
      '--rerank-utility',
      '--salience-threshold', '5',
      '--limit', '10',
    );
  }

  it('text --why renders the ordered, contiguous ranking chain on the hero', () => {
    const out = recallWhyText();
    // Find the hero's block and its ranking line.
    const lines = out.split('\n');
    const rankingLine = lines.find((l) => l.trim().startsWith('ranking:'));
    expect(rankingLine, `no ranking line in output:\n${out}`).toBeDefined();

    // Fired stages must appear in pipeline order within the chain.
    const order = ['interference', 'value', 'utility', 'goal-boost', 'retrieval-count-downweight'];
    const positions = order.map((stage) => rankingLine!.indexOf(stage));
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it('JSON --why includes rerankTrace on the hero item, contiguous chain', () => {
    const out = hippo(
      home,
      { ...env, HIPPO_SESSION_ID: sessionId },
      'recall', 'auth',
      '--why', '--json',
      '--filter-conflicts',
      '--value-aware',
      '--rerank-utility',
      '--salience-threshold', '5',
      '--limit', '10',
    );
    const parsed = JSON.parse(out) as {
      results: Array<{ id: string; rerankTrace?: Array<{ stage: string; scoreBefore: number; scoreAfter: number }> }>;
    };
    const hero = parsed.results.find((r) => r.id === heroId);
    expect(hero, `hero not in results:\n${out}`).toBeDefined();
    expect(hero!.rerankTrace).toBeDefined();
    const trace = hero!.rerankTrace!;
    expect(trace.map((s) => s.stage)).toEqual([
      'interference', 'value', 'utility', 'goal-boost', 'retrieval-count-downweight',
    ]);
    // Contiguous chain: each step's scoreBefore == prior step's scoreAfter.
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i].scoreBefore).toBe(trace[i - 1].scoreAfter);
    }
  });

  it('backward-compat: default recall (no --why) carries no trace markers', () => {
    const out = hippo(home, env, 'recall', 'auth', '--limit', '10');
    expect(out).not.toContain('ranking:');
    expect(out).not.toContain('rerankTrace');

    const jsonOut = hippo(home, env, 'recall', 'auth', '--json', '--limit', '10');
    const parsed = JSON.parse(jsonOut) as { results: Array<Record<string, unknown>> };
    for (const item of parsed.results) {
      expect(item.rerankTrace).toBeUndefined();
      expect(item.rerankPipeline).toBeUndefined();
    }
  });

  it('explicit --goal: recall --why --goal traces the `goal` stage (codex P2 fix)', () => {
    // No HIPPO_SESSION_ID -> the session goal-boost path does not run; only the
    // explicit `--goal <tag>` block fires. Before the fix this produced no
    // ranking line at all for the --goal re-ranker.
    const out = hippo(
      home,
      env,
      'recall', 'auth',
      '--why', '--json',
      '--goal', 'fix-auth',
      '--limit', '10',
    );
    const parsed = JSON.parse(out) as {
      results: Array<{ id: string; rerankTrace?: Array<{ stage: string; multiplier?: number }> }>;
    };
    const hero = parsed.results.find((r) => r.id === heroId);
    expect(hero, `hero not in results:\n${out}`).toBeDefined();
    expect(hero!.rerankTrace).toBeDefined();
    const goalStep = hero!.rerankTrace!.find((s) => s.stage === 'goal');
    expect(goalStep, 'no `goal` stage in trace').toBeDefined();
    expect(goalStep!.multiplier).toBe(1.5);
  });
});
