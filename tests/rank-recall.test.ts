// rankRecall in process: what it ranks, what it hands back for the caller to write, where haltBefore stops it, and its re-rank stages.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { Layer, type MemoryEntry} from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { pushGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { rankRecall, type RankRecallCtx, type RankRecallOpts } from '../src/recall-pipeline.js';
import type { RerankerFn } from '../src/rerankers/types.js';

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

describe('rankRecall re-rank stages', () => {
  const put = (id: string, content: string, extra: Partial<MemoryEntry> = {}): void => {
    writeEntry(hippoRoot, { ...createMemory(content), id, strength: 1, ...extra });
  };
  const rank = (extra: Partial<RankRecallOpts> = {}) => rankRecall(ctx(), opts(extra));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-rank-rerank-'));
    hippoRoot = join(home, '.hippo');
    initStore(hippoRoot);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('evcAdaptive puts the newest of several near-duplicate hits first', async () => {
    put('mem_old', 'deploy target is the cluster in region east zone one', { created: '2024-01-01T00:00:00.000Z' });
    put('mem_mid', 'deploy target is the cluster in region east zone two', { created: '2025-01-01T00:00:00.000Z' });
    put('mem_new', 'deploy target is the cluster in region east zone three', { created: '2026-01-01T00:00:00.000Z' });

    const r = await rank({ evcAdaptive: true });
    expect(ids(r.results)).toEqual(['mem_new', 'mem_mid', 'mem_old']);
  });

  it('evcAdaptive leaves the order alone when the top hits are about different things', async () => {
    put('mem_a', 'deploy rollback needs the previous image tag', { created: '2024-01-01T00:00:00.000Z' });
    put('mem_b', 'deploy windows close friday afternoon for the release train', { created: '2026-01-01T00:00:00.000Z' });

    const plain = ids((await rank()).results);
    expect(ids((await rank({ evcAdaptive: true })).results)).toEqual(plain);
  });

  it('a reranker reorders its top K, its score replaces the old one, and the tail keeps its place', async () => {
    put('mem_1', 'deploy deploy deploy pipeline notes');
    put('mem_2', 'deploy pipeline notes for the runner');
    put('mem_3', 'deploy notes from the older runner setup and its long history of retries');
    const base = ids((await rank()).results);

    const reverse: RerankerFn = async (_q, results) =>
      [...results].reverse().map((r, i) => ({ ...r, rerankScore: 10 - i, preRerankRank: r.preRerankRank ?? 0, postRerankRank: 0 }));
    const r = await rank({ reranker: { fn: reverse, topK: 2 }, why: true });

    expect(ids(r.results)).toEqual([base[1], base[0], base[2]]);
    expect(r.results.map((x) => x.score).slice(0, 2)).toEqual([10, 9]);
    expect(r.results.map((x) => [x.preRerankRank, x.postRerankRank])).toEqual([[2, 1], [1, 2], [undefined, undefined]]);
    expect(r.results[0].rerankTrace?.at(-1)).toMatchObject({ stage: 'reranker', scoreAfter: 10 });
  });

  it('filterConflicts drops superseded rows and down-ranks a row whose recorded conflict is also present', async () => {
    put('mem_strong', 'deploy deploy deploy uses the blue cluster', { conflicts_with: ['mem_weak'] });
    put('mem_weak', 'deploy uses the green cluster', { conflicts_with: ['mem_strong'] });
    put('mem_free', 'deploy checklist lives in the wiki');

    const plain = await rank();
    const before = new Map(plain.results.map((x) => [x.entry.id, x.score]));
    const r = await rank({ filterConflicts: true, why: true });
    const strong = r.results.find((x) => x.entry.id === 'mem_strong')!;
    expect(strong.score).toBeCloseTo(before.get('mem_strong')! * 0.3);
    expect(strong.rerankTrace?.at(-1)).toMatchObject({ stage: 'interference', multiplier: 0.3 });
    expect(r.results.find((x) => x.entry.id === 'mem_free')!.rerankTrace).toBeUndefined();
  });

  it('valueAware lifts rows with good outcome history and sinks ones with bad, clamped to 0.7..1.3', async () => {
    put('mem_good', 'deploy step that worked', { outcome_positive: 9 });
    put('mem_bad', 'deploy step that failed', { outcome_negative: 9 });
    put('mem_none', 'deploy step never rated');

    const before = new Map((await rank()).results.map((x) => [x.entry.id, x.score]));
    const r = await rank({ valueAware: true, why: true });
    const after = new Map(r.results.map((x) => [x.entry.id, x]));
    expect(after.get('mem_good')!.score).toBeCloseTo(before.get('mem_good')! * 1.3);
    expect(after.get('mem_bad')!.score).toBeCloseTo(before.get('mem_bad')! * 0.7);
    expect(after.get('mem_none')!.rerankTrace).toBeUndefined();
    expect(after.get('mem_good')!.rerankTrace?.at(-1)).toMatchObject({ stage: 'value' });
  });

  it('rerankUtility weights each row by its strength', async () => {
    put('mem_firm', 'deploy rule one', { strength: 1 });
    put('mem_faint', 'deploy rule two', { strength: 0 });

    const before = new Map((await rank()).results.map((x) => [x.entry.id, x]));
    const r = await rank({ rerankUtility: true, why: true });
    const faint = r.results.find((x) => x.entry.id === 'mem_faint')!;
    const tokensMult = 1 - Math.min(0.3, before.get('mem_faint')!.tokens / 10000);
    expect(faint.score).toBeCloseTo(before.get('mem_faint')!.score * 0.5 * tokensMult);
    expect(faint.rerankTrace?.at(-1)).toMatchObject({ stage: 'utility' });
  });

  it('salience halves a never-recalled row and leaves a well-recalled one alone', async () => {
    put('mem_hot', 'deploy fact recalled often', { retrieval_count: 10 });
    put('mem_cold', 'deploy fact never recalled', { retrieval_count: 0 });

    const before = new Map((await rank()).results.map((x) => [x.entry.id, x.score]));
    const r = await rank({ salienceThreshold: 5, why: true });
    const after = new Map(r.results.map((x) => [x.entry.id, x]));
    expect(after.get('mem_hot')!.rerankTrace).toBeUndefined();
    expect(after.get('mem_cold')!.score).toBeCloseTo(before.get('mem_cold')! * 0.5);
    expect(after.get('mem_cold')!.rerankTrace?.at(-1)).toMatchObject({ stage: 'retrieval-count-downweight', multiplier: 0.5 });
  });

  it('asOf returns the row that was true at that date, before or after its successor took over', async () => {
    put('mem_v1', 'deploy region was us-east', { valid_from: '2024-01-01T00:00:00.000Z', superseded_by: 'mem_v2' });
    put('mem_v2', 'deploy region is eu-west', { valid_from: '2025-06-01T00:00:00.000Z' });

    expect(ids((await rank({ asOf: '2025-01-01T00:00:00.000Z' })).results)).toEqual(['mem_v1']);
    expect(ids((await rank({ asOf: '2026-01-01T00:00:00.000Z' })).results)).toEqual(['mem_v2']);
    expect(ids((await rank({ asOf: '2023-01-01T00:00:00.000Z' })).results)).toEqual([]);
  });
});
