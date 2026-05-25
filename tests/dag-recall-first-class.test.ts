/**
 * v0.30 / E4 of DAG live-coupling — first-class DAG recall (scoring layer) tests.
 *
 * Locks: summaryDeboost precedence (per-call > env > 0.85 default), freshness
 * micro-boost (1.05 when last_rebuilt_at within 7 days), DAG metadata in
 * ScoreBreakdown when explain=true, physicsSearch physics-particle path,
 * physicsSearch hybridSearch-fallback inheritance via options spread,
 * shared.searchBothHybrid pass-through + composition invariant, MMR + reranker
 * interactions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry } from '../src/store.js';
import { openHippoDb } from '../src/db.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { hybridSearch, physicsSearch, isDagSummary, type SearchResult } from '../src/search.js';
import { searchBothHybrid } from '../src/shared.js';
import { savePhysicsState } from '../src/physics-state.js';
import type { PhysicsParticle } from '../src/physics.js';

function makeL2Summary(
  content: string,
  opts: { lastRebuiltAt?: string | null; rebuildCount?: number; descendantCount?: number } = {},
): MemoryEntry {
  const s = createMemory(content, {
    layer: Layer.Semantic,
    tags: ['topic:test', 'dag-summary'],
    confidence: 'inferred',
    dag_level: 2,
  });
  if (opts.lastRebuiltAt !== undefined) s.last_rebuilt_at = opts.lastRebuiltAt;
  if (opts.rebuildCount !== undefined) s.rebuild_count = opts.rebuildCount;
  if (opts.descendantCount !== undefined) s.descendant_count = opts.descendantCount;
  return s;
}

function makeL1Fact(content: string, parentId?: string): MemoryEntry {
  return createMemory(content, {
    layer: Layer.Episodic,
    tags: ['extracted'],
    dag_level: 1,
    dag_parent_id: parentId,
  });
}

function findResult(results: SearchResult[], id: string): SearchResult | undefined {
  return results.find((r) => r.entry.id === id);
}

describe('v0.30 / E4 — first-class DAG recall (scoring layer)', () => {
  let hippoRoot: string;
  let savedDeboost: string | undefined;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dag-e4-'));
    initStore(hippoRoot);
    savedDeboost = process.env.HIPPO_SUMMARY_DEBOOST;
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
    if (savedDeboost !== undefined) process.env.HIPPO_SUMMARY_DEBOOST = savedDeboost;
    else delete process.env.HIPPO_SUMMARY_DEBOOST;
  });

  it('test #1: default deboost (0.85) applies to L2 summary, NOT to L1 fact', async () => {
    const summary = makeL2Summary('shared rare-token-xyz cluster summary');
    const fact = makeL1Fact('shared rare-token-xyz fact alpha');
    writeEntry(hippoRoot, summary);
    writeEntry(hippoRoot, fact);

    const results = await hybridSearch('rare-token-xyz', [summary, fact], { explain: true });
    const sResult = findResult(results, summary.id);
    const fResult = findResult(results, fact.id);
    expect(sResult?.breakdown?.summaryDeboost).toBeCloseTo(0.85);
    // L1 fact: deboost field not populated (only L2 gets the 4 summary-specific fields)
    expect(fResult?.breakdown?.summaryDeboost).toBeUndefined();
  });

  it('test #2: per-call summaryDeboost=1.0 disables', async () => {
    const summary = makeL2Summary('disable-deboost test summary');
    writeEntry(hippoRoot, summary);
    const results = await hybridSearch('disable-deboost', [summary], { explain: true, summaryDeboost: 1.0 });
    expect(results[0]?.breakdown?.summaryDeboost).toBe(1.0);
  });

  it('test #3: env HIPPO_SUMMARY_DEBOOST respected', async () => {
    process.env.HIPPO_SUMMARY_DEBOOST = '0.5';
    const summary = makeL2Summary('env-deboost test summary');
    writeEntry(hippoRoot, summary);
    const results = await hybridSearch('env-deboost', [summary], { explain: true });
    expect(results[0]?.breakdown?.summaryDeboost).toBeCloseTo(0.5);
  });

  it('test #4: env out-of-range falls back to 0.85', async () => {
    const summary = makeL2Summary('out-of-range test summary');
    writeEntry(hippoRoot, summary);

    for (const bad of ['2.0', '0.0', 'NaN', '-0.5', 'garbage']) {
      process.env.HIPPO_SUMMARY_DEBOOST = bad;
      const results = await hybridSearch('out-of-range', [summary], { explain: true });
      expect(results[0]?.breakdown?.summaryDeboost).toBeCloseTo(0.85);
    }
  });

  it('test #5: per-call option overrides env', async () => {
    process.env.HIPPO_SUMMARY_DEBOOST = '0.5';
    const summary = makeL2Summary('override-env summary');
    writeEntry(hippoRoot, summary);
    const results = await hybridSearch('override-env', [summary], { explain: true, summaryDeboost: 0.7 });
    expect(results[0]?.breakdown?.summaryDeboost).toBeCloseTo(0.7);
  });

  it('test #6: freshness boost (1.05) when last_rebuilt_at within 7 days', async () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const summary = makeL2Summary('fresh summary content', { lastRebuiltAt: oneDayAgo });
    writeEntry(hippoRoot, summary);
    const results = await hybridSearch('fresh summary', [summary], { explain: true });
    expect(results[0]?.breakdown?.summaryFreshnessBoost).toBeCloseTo(1.05);
  });

  it('test #7: no freshness when last_rebuilt_at null', async () => {
    const summary = makeL2Summary('never-rebuilt summary', { lastRebuiltAt: null });
    writeEntry(hippoRoot, summary);
    const results = await hybridSearch('never-rebuilt', [summary], { explain: true });
    expect(results[0]?.breakdown?.summaryFreshnessBoost).toBe(1.0);
  });

  it('test #8: no freshness when last_rebuilt_at > 7 days old', async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const summary = makeL2Summary('stale summary content', { lastRebuiltAt: thirtyDaysAgo });
    writeEntry(hippoRoot, summary);
    const results = await hybridSearch('stale summary', [summary], { explain: true });
    expect(results[0]?.breakdown?.summaryFreshnessBoost).toBe(1.0);
  });

  it('test #9: no freshness when last_rebuilt_at is garbage string', async () => {
    const summary = makeL2Summary('garbage timestamp summary', { lastRebuiltAt: 'not-a-date' });
    writeEntry(hippoRoot, summary);
    const results = await hybridSearch('garbage timestamp', [summary], { explain: true });
    expect(results[0]?.breakdown?.summaryFreshnessBoost).toBe(1.0);
  });

  it('test #10: deboost + freshness compose for fresh summary (0.85 * 1.05)', async () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const summary = makeL2Summary('compose-test summary content', { lastRebuiltAt: oneDayAgo });
    writeEntry(hippoRoot, summary);
    const results = await hybridSearch('compose-test', [summary], { explain: true });
    const br = results[0]?.breakdown;
    expect(br?.summaryDeboost).toBeCloseTo(0.85);
    expect(br?.summaryFreshnessBoost).toBeCloseTo(1.05);
    // final = composite (pre-deboost) * 0.85 * 1.05 = composite * 0.8925
  });

  it('test #11: physicsSearch physics-particle path applies deboost', async () => {
    const summary = makeL2Summary('physics-particle deboost summary');
    writeEntry(hippoRoot, summary);

    // Seed physics state so physicsSearch picks the physics-particle path
    const dim = 4;
    const queryVec = [1, 0, 0, 0];
    const particle: PhysicsParticle = {
      memoryId: summary.id,
      position: [1, 0, 0, 0],  // perfect cosine match with query
      velocity: [0, 0, 0, 0],
      mass: 1.0,
      charge: 0,
      temperature: 0.5,
      lastSimulation: new Date().toISOString(),
    };
    const db = openHippoDb(hippoRoot);
    try {
      savePhysicsState(db, [particle]);
    } finally {
      db.close();
    }

    const results = await physicsSearch('physics-particle test', [summary], {
      hippoRoot,
      queryEmbedding: queryVec,
      explain: true,
    });
    const br = findResult(results, summary.id)?.breakdown;
    expect(br?.mode).toBe('physics');
    expect(br?.summaryDeboost).toBeCloseTo(0.85);
    expect(br?.dagLevel).toBe(2);
  });

  it('test #12: explain mode populates 6 breakdown fields for L2', async () => {
    const summary = makeL2Summary('explain-test summary', {
      lastRebuiltAt: new Date().toISOString(),
      rebuildCount: 3,
      descendantCount: 5,
    });
    writeEntry(hippoRoot, summary);
    const results = await hybridSearch('explain-test', [summary], { explain: true });
    const br = results[0]?.breakdown;
    expect(br?.dagLevel).toBe(2);
    expect(br?.descendantCount).toBe(5);
    expect(br?.lastRebuiltAt).toBeTruthy();
    expect(br?.rebuildCount).toBe(3);
    expect(br?.summaryDeboost).toBeCloseTo(0.85);
    expect(br?.summaryFreshnessBoost).toBeCloseTo(1.05);
  });

  it('test #13: MMR-on with deboost-on — observed rank-shift documented', async () => {
    // Setup: 1 L2 summary + 3 distinct L1 facts, all matching query.
    // Without deboost, summary tends to rank highest (dense, all query terms present).
    // With deboost, summary score is multiplied by 0.85 → MMR's pre-rank input is post-deboost.
    const summary = makeL2Summary('mmr-test alpha beta gamma combined summary content');
    const f1 = makeL1Fact('mmr-test alpha distinct fact one');
    const f2 = makeL1Fact('mmr-test beta distinct fact two');
    const f3 = makeL1Fact('mmr-test gamma distinct fact three');
    [summary, f1, f2, f3].forEach((e) => writeEntry(hippoRoot, e));
    const entries = [summary, f1, f2, f3];

    // Run twice: once with deboost ON (default), once disabled
    const withDeboost = await hybridSearch('mmr-test', entries, { explain: true, mmr: true, mmrLambda: 0.5 });
    const withoutDeboost = await hybridSearch('mmr-test', entries, { explain: true, mmr: true, mmrLambda: 0.5, summaryDeboost: 1.0 });

    const sIdxWith = withDeboost.findIndex((r) => r.entry.id === summary.id);
    const sIdxWithout = withoutDeboost.findIndex((r) => r.entry.id === summary.id);
    // Document observed behavior: deboost SHOULD push summary down OR keep same rank
    expect(sIdxWith).toBeGreaterThanOrEqual(sIdxWithout);
  });

  it('test #14: reranker receives post-deboost ordering; final order is rerankers prerogative', async () => {
    // Mock reranker that RECORDS what it received. Asserts reranker input is
    // post-deboost (the L2 summary in the input has score = pre-deboost * 0.85).
    // We do NOT assert reranker final order; reranker is free to reorder.
    let recordedInputs: SearchResult[] | null = null;
    const recordingReranker = vi.fn(async (
      _query: string,
      results: SearchResult[],
      _opts?: import('../src/rerankers/types.js').RerankerOptions,
    ): Promise<SearchResult[]> => {
      recordedInputs = JSON.parse(JSON.stringify(results)); // deep snapshot
      // Reverse order (the "prerogative" branch — we don't assert this)
      return [...results].reverse();
    });

    const summary = makeL2Summary('reranker-test summary alpha beta');
    const fact = makeL1Fact('reranker-test fact gamma');
    writeEntry(hippoRoot, summary);
    writeEntry(hippoRoot, fact);

    // Baseline: deboost=1.0 to get pre-deboost summary score
    const baseline = await hybridSearch('reranker-test', [summary, fact], {
      explain: true,
      summaryDeboost: 1.0,
    });
    const summaryBaseScore = findResult(baseline, summary.id)?.score ?? 0;
    expect(summaryBaseScore).toBeGreaterThan(0);

    // Run with reranker + default deboost
    await hybridSearch('reranker-test', [summary, fact], {
      explain: true,
      reranker: recordingReranker,
    });
    expect(recordingReranker).toHaveBeenCalled();
    expect(recordedInputs).not.toBeNull();
    const rerankerSawSummary = (recordedInputs as unknown as SearchResult[]).find((r) => r.entry.id === summary.id);
    expect(rerankerSawSummary).toBeTruthy();
    // The summary the reranker SAW had its score multiplied by 0.85
    expect(rerankerSawSummary!.score).toBeCloseTo(summaryBaseScore * 0.85, 5);
  });

  it('test #16: shared.searchBothHybrid pass-through composition invariant', async () => {
    // L2 summary in localRoot, last_rebuilt_at=null (avoids freshness factor)
    const summary = makeL2Summary('shared-test summary compose check', { lastRebuiltAt: null });
    writeEntry(hippoRoot, summary);

    // Empty global root (no global path; the function tolerates missing dir)
    const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-e4-global-empty-'));
    try {
      const results = await searchBothHybrid('shared-test', hippoRoot, globalRoot, { explain: true });
      const sResult = findResult(results, summary.id);
      const br = sResult?.breakdown;
      expect(br?.summaryDeboost).toBeCloseTo(0.85);
      expect(br?.summaryFreshnessBoost).toBeCloseTo(1.0);
      expect(br?.sourceBump).toBeCloseTo(1.2);
      // Composition invariant (AC16): after shared.ts re-wrap, score = composite * sourceBump
      // and final = composite * sourceBump (same). So final / score should be exactly 1.0.
      // The deboost (0.85) and freshness (1.0) already baked into composite at hybridSearch
      // time; sourceBump (1.2) is the only post-hybridSearch multiplier.
      expect(br!.final / sResult!.score).toBeCloseTo(1.0, 5);
    } finally {
      fs.rmSync(globalRoot, { recursive: true, force: true });
    }
  });

  it('test #17: physicsSearch hybridSearch-fallback inherits deboost via options spread', async () => {
    // No physics state seeded for L2 summary → physicsSearch falls back to
    // hybridSearch via L685/689/693/707 once it detects no particle for the entry.
    // Actually physicsSearch's fallbacks at L780-789 fire when embedding is
    // unavailable / model mismatch / empty queryVector. Without hippoRoot or
    // with queryEmbedding=[], it returns hybridSearch's results.
    const summary = makeL2Summary('fallback-test summary content');
    writeEntry(hippoRoot, summary);
    // Force fallback path: pass queryEmbedding=[] AND no embedding service
    // (which the test env doesn't have anyway). physicsSearch should hit the
    // `if (!isEmbeddingAvailable()) return hybridSearch(...)` branch.
    const results = await physicsSearch('fallback-test', [summary], {
      hippoRoot,
      explain: true,
    });
    // Fallback to hybridSearch → deboost applied
    const br = findResult(results, summary.id)?.breakdown;
    expect(br?.summaryDeboost).toBeCloseTo(0.85);
  });

  it('test #18: isDagSummary helper matches dag_level === 2 only', () => {
    const l2 = makeL2Summary('l2-summary-content');
    const l1 = makeL1Fact('l1 fact content');
    const l0 = createMemory('l0 raw content', { layer: Layer.Episodic });
    // l0 has no dag_level — undefined; helper returns false
    expect(isDagSummary(l2)).toBe(true);
    expect(isDagSummary(l1)).toBe(false);
    expect(isDagSummary(l0)).toBe(false);
  });
});
