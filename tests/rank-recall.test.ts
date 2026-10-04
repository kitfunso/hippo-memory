// rankRecall in process: what it ranks, what it hands back for the caller to write, and where haltBefore stops it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { Layer, type MemoryEntry} from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { pushGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { rankRecall, type RankRecallCtx, type RankRecallOpts } from '../src/recall-pipeline.js';

let home: string;
let hippoRoot: string;

function seeded(content: string, id: string, extra: Partial<MemoryEntry> = {}, opts: Parameters<typeof createMemory>[1] = {}): MemoryEntry {
  return { ...createMemory(content, opts), id, strength: 1, ...extra };
}

function opts(extra: Partial<RankRecallOpts> = {}): RankRecallOpts {
  const config = loadConfig(hippoRoot);
  return {
    query: 'deploy',
    budget: 4000,
    cost: (r) => r.tokens,
    limit: 10,
    includeSuperseded: false,
    explicitScope: null,
    activeScope: null,
    search: { usePhysics: false, physicsConfig: config.physics, multihop: false, mmr: false, mmrLambda: 0.7, localBump: 1.2, explain: false },
    ...extra,
  };
}

interface CountRow { n: number }

function goalLogCount(): number {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: COUNT(*) AS n always returns exactly one row with a numeric n.
    const row = db.prepare('SELECT COUNT(*) AS n FROM goal_recall_log').get() as CountRow;
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

const ids = (results: { entry: MemoryEntry }[]): string[] => results.map((r) => r.entry.id);
const ctx = (): RankRecallCtx => ({ hippoRoot, tenantId: 'default' });

describe('rankRecall', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-rank-recall-'));
    hippoRoot = join(home, '.hippo');
    initStore(hippoRoot);
    writeEntry(hippoRoot, seeded('deploy pipeline uses blue green rollout', 'mem_rank_plain'));
    writeEntry(hippoRoot, seeded('private deploy token rotation', 'mem_rank_private', {}, { scope: 'slack:private:C1' }));
    writeEntry(hippoRoot, seeded('deploy target was the old cluster', 'mem_rank_old', { superseded_by: 'mem_rank_plain' }));
    writeEntry(hippoRoot, seeded('deploy goal work on the runner', 'mem_rank_goal', {}, { tags: ['goal-alpha'] }));
    writeEntry(hippoRoot, seeded('deploy trace: promoted the canary', 'mem_rank_trace', {}, { layer: Layer.Trace, trace_outcome: 'success' }));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // Private and superseded rows are excluded in SQL, so they are pre-candidate: neither counted nor dropped.
  it('ranks the admitted pool and leaves out private and superseded rows', async () => {
    const rank = await rankRecall(ctx(), opts());
    expect(ids(rank.results).sort()).toEqual(['mem_rank_goal', 'mem_rank_plain', 'mem_rank_trace']);
    expect(rank.droppedPreRank).toBe(0);
    expect(rank.totalCandidates).toBe(3);
    expect(rank.halted).toBe(false);
  });

  it('an explicit scope unlocks that private scope on top of the default set', async () => {
    const rank = await rankRecall(ctx(), opts({ explicitScope: 'slack:private:C1' }));
    expect(ids(rank.results)).toContain('mem_rank_private');
    expect(ids(rank.results)).toContain('mem_rank_plain');
  });

  it('returns the goal-stack log rows and writes none of them', async () => {
    pushGoal(hippoRoot, { sessionId: 's-rank', tenantId: 'default', goalName: 'goal-alpha' });
    const rank = await rankRecall(ctx(), opts({ sessionId: 's-rank' }));
    expect(rank.goalRecallLog.map((r) => r.memoryId)).toEqual(['mem_rank_goal']);
    expect(ids(rank.results)[0]).toBe('mem_rank_goal');
    expect(goalLogCount()).toBe(0);
  });

  it('haltBefore stops ahead of the named stage', async () => {
    const full = await rankRecall(ctx(), opts({ layer: Layer.Trace }));
    expect(ids(full.results)).toEqual(['mem_rank_trace']);
    const halted = await rankRecall(ctx(), opts({ layer: Layer.Trace, haltBefore: 'layer' }));
    expect(halted.halted).toBe(true);
    expect(ids(halted.results)).toHaveLength(3);
  });
});
