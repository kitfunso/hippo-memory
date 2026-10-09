/**
 * A/B Benchmark: Physics Search vs Classic Search
 *
 * Uses synthetic embeddings (deterministic, fast) to test physics scoring
 * against classic BM25+cosine. Memories in the same cluster get similar
 * embedding vectors; unrelated memories get orthogonal vectors.
 *
 * This isolates the physics scoring logic from embedding model quality.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  type MemoryEntry
} from '../src/core/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { hybridSearch } from '../src/search/hybrid.js';
import { physicsSearch } from '../src/search/physics-search.js';
import { saveEmbeddingIndex } from '../src/store/vector-index.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import {
  loadPhysicsState,
  resetAllPhysicsState,
  savePhysicsState,
} from '../src/db/physics-state.js';
import { simulate, type ForceContext } from '../src/core/physics.js';
import { DEFAULT_PHYSICS_CONFIG } from '../src/core/physics-config.js';

// A benchmark: 50 simulate-and-save cycles of a pairwise force loop, which coverage instrumentation slows far more than other code.
vi.setConfig({ testTimeout: 60_000 });

// ---------------------------------------------------------------------------
// Synthetic embedding generator
// ---------------------------------------------------------------------------

const EMBED_DIM = 384;

/** Generate a deterministic unit vector from a seed. Seeded hash -> direction. */
function syntheticEmbedding(seed: number): number[] {
  const vec = new Array<number>(EMBED_DIM);
  // Simple deterministic pseudo-random using seed
  let s = seed;
  for (let i = 0; i < EMBED_DIM; i++) {
    s = ((s * 1103515245 + 12345) & 0x7fffffff) >>> 0;
    vec[i] = (s / 0x7fffffff) * 2 - 1;
  }
  // Normalize to unit vector
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return vec;
}

/** Create a cluster of similar embeddings: base vector + small noise. */
function clusterEmbedding(base: number[], noiseSeed: number, noiseScale = 0.15): number[] {
  const vec = [...base];
  let s = noiseSeed;
  for (let i = 0; i < EMBED_DIM; i++) {
    s = ((s * 1103515245 + 12345) & 0x7fffffff) >>> 0;
    vec[i] += ((s / 0x7fffffff) * 2 - 1) * noiseScale;
  }
  // Re-normalize
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return vec;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
const seedIds: Record<string, string> = {};
const embeddingIndex: Record<string, number[]> = {};

// Cluster centroids (orthogonal-ish directions in 384-dim space)
const FRED_CENTROID = syntheticEmbedding(100);
const SUBAGENT_CENTROID = syntheticEmbedding(200);
const QUANT_CENTROID = syntheticEmbedding(300);
const PIPELINE_CENTROID = syntheticEmbedding(400);
const PLATFORM_CENTROID = syntheticEmbedding(500);
const FRONTEND_CENTROID = syntheticEmbedding(600);
const OPS_CENTROID = syntheticEmbedding(700);
const PRODUCTION_CENTROID = syntheticEmbedding(800);

function seed(
  label: string,
  content: string,
  embedding: number[],
  opts: Parameters<typeof createMemory>[1] = {}
): MemoryEntry {
  const entry = createMemory(content, opts);
  const withLabel: MemoryEntry = { ...entry, id: `pb_${label}` };
  writeEntry(tmpDir, withLabel);
  seedIds[label] = withLabel.id;
  embeddingIndex[withLabel.id] = embedding;
  return withLabel;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-physics-bench-'));
  initStore(tmpDir);

  // ── FRED cluster (3 tightly clustered memories) ──────────────────────
  seed('fred_cache_drop',
    `FRED cache can silently drop series. tips_10y vanished from fred_weekly.parquet during daily refresh, breaking the gold model.`,
    clusterEmbedding(FRED_CENTROID, 1),
    { tags: ['data-pipeline', 'fred', 'error'], emotional_valence: 'negative' });

  seed('fred_fallback',
    `FRED as fallback for dead data URLs. IMF and FAO went 404. Same indices available on FRED. More reliable than scraping.`,
    clusterEmbedding(FRED_CENTROID, 2),
    { tags: ['data-pipeline', 'fred', 'imf'] });

  seed('fred_column_alias',
    `FRED cache column alias map. Production models reference names that differ from fred cache keys: tips_10y, yield_curve_3m, wti_spot.`,
    clusterEmbedding(FRED_CENTROID, 3),
    { tags: ['data-pipeline', 'fred', 'columns'] });

  // ── Sub-agent cluster ─────────────────────────────────────────────────
  seed('subagent_american_english',
    `Sub-agents consistently use American English spelling. Review output: favorable, maximize, optimize.`,
    clusterEmbedding(SUBAGENT_CENTROID, 1),
    { tags: ['sub-agent', 'review', 'spelling'] });

  seed('subagent_slop_words',
    `Sub-agents produce AI slop words. Offenders: comprehensive, robust, leverage, harness, tapestry.`,
    clusterEmbedding(SUBAGENT_CENTROID, 2),
    { tags: ['sub-agent', 'review', 'copywriting'] });

  seed('subagent_fabrication',
    `Always verify sub-agent model metrics. Natgas V3 claimed Min Sharpe 0.99 -> 1.60. Actual: CV=-0.73.`,
    clusterEmbedding(SUBAGENT_CENTROID, 3),
    { tags: ['sub-agent', 'verification', 'error'], emotional_valence: 'critical' });

  // ── Quant/backtest cluster ────────────────────────────────────────────
  seed('walk_forward_overestimates',
    `Walk-forward OOS Sharpe overestimates by ~50%. CPCV shows deflation of +0.59 on average.`,
    clusterEmbedding(QUANT_CENTROID, 1),
    { tags: ['quant', 'backtest', 'sharpe'] });

  seed('data_mining_honesty',
    `Data mining honesty: selected features by testing on ALL data, then claimed good OOS results. Must use theory-only selection.`,
    clusterEmbedding(QUANT_CENTROID, 2),
    { tags: ['quant', 'data-mining', 'feature-selection'] });

  seed('cpcv_deflation',
    `CPCV deflation needed for honest Sharpe reporting. Walk-forward inflates by ~50%.`,
    clusterEmbedding(QUANT_CENTROID, 3),
    { tags: ['quant', 'cpcv', 'sharpe'] });

  // ── Data pipeline errors cluster ──────────────────────────────────────
  seed('eia_path_change',
    `EIA API path changed silently. /petroleum/sum/wkly became /petroleum/sum/sndw. Broke 9 of 10 series.`,
    clusterEmbedding(PIPELINE_CENTROID, 1),
    { tags: ['data-pipeline', 'eia', 'api', 'error'], emotional_valence: 'negative' });

  seed('staleness_hides_ok',
    `Data source staleness hides behind OK reports. 5+ sources silently stale while refresh reported 14/14 OK.`,
    clusterEmbedding(PIPELINE_CENTROID, 2),
    { tags: ['data-pipeline', 'staleness', 'monitoring'] });

  seed('wb_column_names',
    `WB Pink Sheet column names must be preserved exactly. Never rename without checking all production models.`,
    clusterEmbedding(PIPELINE_CENTROID, 3),
    { tags: ['data-pipeline', 'world-bank', 'columns'] });

  seed('cache_column_mismatch',
    `Cache column mismatches break models silently. Models reference columns not in cache series maps.`,
    clusterEmbedding(PIPELINE_CENTROID, 4),
    { tags: ['data-pipeline', 'cache', 'columns'] });

  // ── Platform cluster ──────────────────────────────────────────────────
  seed('no_emoji_python',
    `No emoji in Python print statements on Windows. cp1252 encoding crashes on emoji characters.`,
    clusterEmbedding(PLATFORM_CENTROID, 1),
    { tags: ['platform', 'windows', 'encoding'], emotional_valence: 'negative' });

  seed('powershell_semicolons',
    `PowerShell uses semicolons not && to chain commands. The && operator causes silent failure.`,
    clusterEmbedding(PLATFORM_CENTROID, 2),
    { tags: ['platform', 'powershell', 'windows'] });

  // ── Production rules ──────────────────────────────────────────────────
  seed('never_overwrite',
    `NEVER overwrite existing production files. Create versioned copies. Violating destroys PnL history.`,
    clusterEmbedding(PRODUCTION_CENTROID, 1),
    { tags: ['production', 'rule', 'critical'], emotional_valence: 'critical', pinned: true });

  seed('version_files',
    `Version production files before modifying. Always create a backup copy before touching production files.`,
    clusterEmbedding(PRODUCTION_CENTROID, 2),
    { tags: ['production', 'rule', 'versioning'] });

  // ── Frontend cluster ──────────────────────────────────────────────────
  seed('build_before_deploy',
    `Always run build before deploying frontend. Missing the build step deploys stale code.`,
    clusterEmbedding(FRONTEND_CENTROID, 1),
    { tags: ['frontend', 'deploy', 'build'] });

  seed('constants_must_sync',
    `Frontend and backend trading constants must stay in sync. Mismatch causes wrong sizing.`,
    clusterEmbedding(FRONTEND_CENTROID, 2),
    { tags: ['frontend', 'backend', 'constants'] });

  // ── Ops cluster ───────────────────────────────────────────────────────
  seed('cron_timeout_sizing',
    `Cron timeout sizing for heavy jobs. Default to >=900s. Run manual timed pass first.`,
    clusterEmbedding(OPS_CENTROID, 1),
    { tags: ['ops', 'cron', 'timeout'] });

  seed('friday_time_guards',
    `Friday quant cron jobs have hard time guards: 20:30-22:30 Europe/London only.`,
    clusterEmbedding(OPS_CENTROID, 2),
    { tags: ['ops', 'cron', 'scheduling'] });

  // ── Isolated memories (no cluster) ────────────────────────────────────
  seed('equal_weight_beats_optimization',
    `Equal weight beats portfolio optimization. 1/N allocation Sharpe 3.12 beats all optimization schemes.`,
    syntheticEmbedding(901),
    { tags: ['quant', 'portfolio', 'optimization'] });

  seed('natgas_gfc_period',
    `Natgas 2008-2009 GFC tanks CV. Sharpe=-1.89 in 2008. GFC broke natgas pricing relationships.`,
    syntheticEmbedding(902),
    { tags: ['quant', 'natgas', 'gfc'] });

  seed('natgas_v4_details',
    `Natgas V4 deployed: 18 features, Min Sharpe 1.08. Config: tw=78, rw=26, C=0.20.`,
    syntheticEmbedding(903),
    { tags: ['quant', 'natgas', 'model'] });

  seed('alternative_data_sources',
    `Alternative data sources: NDVI, satellite imagery, soil moisture, sea surface temperatures, AIS.`,
    syntheticEmbedding(904),
    { tags: ['data-sources', 'alternative', 'quant'] });

  seed('subagent_novel_data',
    `Suggest novel data sources proactively. Think beyond conventional financial/macro sources.`,
    syntheticEmbedding(905),
    { tags: ['sub-agent', 'data-sources', 'creativity'] });

  // ── Save synthetic embeddings and initialize physics ──────────────────
  saveEmbeddingIndex(tmpDir, embeddingIndex);

  const db = openHippoDb(tmpDir);
  try {
    const entries = loadAllEntries(tmpDir);
    const resetCount = resetAllPhysicsState(db, entries, embeddingIndex);

    // Run 10 sleep cycles to let clusters form
    for (let cycle = 0; cycle < 10; cycle++) {
      const physicsMap = loadPhysicsState(db);
      const particles = Array.from(physicsMap.values());
      if (particles.length === 0) break;

      const conflictPairs = new Map<string, Set<string>>();
      const halfLives = new Map<string, number>();
      for (const entry of entries) {
        halfLives.set(entry.id, entry.half_life_days);
        if (entry.conflicts_with.length > 0) {
          const set = new Set<string>();
          for (const cid of entry.conflicts_with) set.add(cid);
          conflictPairs.set(entry.id, set);
        }
      }

      const ctx: ForceContext = { conflictPairs, halfLives, config: DEFAULT_PHYSICS_CONFIG };
      simulate(particles, ctx);
      savePhysicsState(db, particles);
    }

    const finalState = loadPhysicsState(db);
    console.log(`  Physics initialized: ${resetCount} particles, 10 sleep cycles`);
    console.log(`  Final particle count: ${finalState.size}`);
  } finally {
    closeHippoDb(db);
  }
}, 30_000);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

interface QueryCase {
  query: string;
  queryEmbedding: number[]; // synthetic query vector
  expectedLabels: string[];
}

async function runClassic(query: string): Promise<string[]> {
  const entries = loadAllEntries(tmpDir);
  const results = await hybridSearch(query, entries, { budget: 8000, hippoRoot: tmpDir });
  return results.slice(0, 10).map((r) => r.entry.id);
}

async function runPhysics(query: string, queryEmbedding?: number[]): Promise<string[]> {
  const entries = loadAllEntries(tmpDir);
  const results = await physicsSearch(query, entries, {
    budget: 8000,
    hippoRoot: tmpDir,
    physicsConfig: DEFAULT_PHYSICS_CONFIG,
    queryEmbedding,
  });
  return results.slice(0, 10).map((r) => r.entry.id);
}

function precision3(topIds: string[], expectedIds: string[]): number {
  const hits = topIds.slice(0, 3).filter((id) => expectedIds.includes(id)).length;
  return hits / 3;
}

function recallK(topIds: string[], expectedIds: string[], k = 3): number {
  if (expectedIds.length === 0) return 1;
  const hits = topIds.slice(0, k).filter((id) => expectedIds.includes(id)).length;
  return hits / expectedIds.length;
}

function mrr(topIds: string[], expectedIds: string[]): number {
  for (let i = 0; i < Math.min(topIds.length, 10); i++) {
    if (expectedIds.includes(topIds[i])) return 1 / (i + 1);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Standard queries (keyword-heavy — BM25 should do well)
// ---------------------------------------------------------------------------

const STANDARD_QUERIES: QueryCase[] = [
  { query: 'why is gold model broken', queryEmbedding: FRED_CENTROID, expectedLabels: ['fred_cache_drop', 'cache_column_mismatch', 'fred_column_alias'] },
  { query: 'deploying to production', queryEmbedding: PRODUCTION_CENTROID, expectedLabels: ['build_before_deploy', 'version_files', 'never_overwrite'] },
  { query: 'python print crashes on windows', queryEmbedding: PLATFORM_CENTROID, expectedLabels: ['no_emoji_python'] },
  { query: 'sub-agent output review', queryEmbedding: SUBAGENT_CENTROID, expectedLabels: ['subagent_american_english', 'subagent_slop_words', 'subagent_fabrication'] },
  { query: 'data refresh failed', queryEmbedding: PIPELINE_CENTROID, expectedLabels: ['fred_cache_drop', 'eia_path_change', 'wb_column_names', 'staleness_hides_ok'] },
  { query: 'backtest results seem too good', queryEmbedding: QUANT_CENTROID, expectedLabels: ['walk_forward_overestimates', 'data_mining_honesty', 'cpcv_deflation'] },
  { query: 'modifying production model file', queryEmbedding: PRODUCTION_CENTROID, expectedLabels: ['never_overwrite', 'version_files'] },
  { query: 'frontend deploy process build', queryEmbedding: FRONTEND_CENTROID, expectedLabels: ['build_before_deploy', 'constants_must_sync'] },
  { query: 'PowerShell command chaining', queryEmbedding: PLATFORM_CENTROID, expectedLabels: ['powershell_semicolons'] },
  { query: 'cache column missing broken', queryEmbedding: PIPELINE_CENTROID, expectedLabels: ['cache_column_mismatch', 'fred_column_alias', 'wb_column_names'] },
];

// ---------------------------------------------------------------------------
// Cluster queries (physics should outperform — broad queries where
// the answer is a cluster of 3+ related memories)
// ---------------------------------------------------------------------------

const CLUSTER_QUERIES: QueryCase[] = [
  {
    query: 'FRED data pipeline issues',
    queryEmbedding: FRED_CENTROID,
    expectedLabels: ['fred_cache_drop', 'fred_fallback', 'fred_column_alias'],
  },
  {
    query: 'problems with sub-agents',
    queryEmbedding: SUBAGENT_CENTROID,
    expectedLabels: ['subagent_american_english', 'subagent_slop_words', 'subagent_fabrication'],
  },
  {
    query: 'data source columns breaking models',
    queryEmbedding: PIPELINE_CENTROID,
    expectedLabels: ['wb_column_names', 'cache_column_mismatch', 'fred_column_alias'],
  },
  {
    query: 'backtest methodology concerns',
    queryEmbedding: QUANT_CENTROID,
    expectedLabels: ['walk_forward_overestimates', 'data_mining_honesty', 'cpcv_deflation'],
  },
  {
    query: 'data pipeline monitoring failures',
    queryEmbedding: PIPELINE_CENTROID,
    expectedLabels: ['staleness_hides_ok', 'eia_path_change', 'fred_cache_drop'],
  },
];

// ---------------------------------------------------------------------------
// A/B comparison
// ---------------------------------------------------------------------------

interface Metrics {
  readonly p3: number;
  readonly r3: number;
  readonly mrr: number;
}

interface QueryScore {
  readonly query: string;
  readonly expectedCount: number;
  readonly classic: Metrics;
  readonly physics: Metrics;
}

function metrics(topIds: string[], expectedIds: string[]): Metrics {
  return { p3: precision3(topIds, expectedIds), r3: recallK(topIds, expectedIds), mrr: mrr(topIds, expectedIds) };
}

async function scoreQueries(cases: readonly QueryCase[]): Promise<QueryScore[]> {
  const scores: QueryScore[] = [];
  for (const tc of cases) {
    const expectedIds = tc.expectedLabels.map((l) => seedIds[l]).filter(Boolean);
    const classicIds = await runClassic(tc.query);
    const physicsIds = await runPhysics(tc.query, tc.queryEmbedding);
    scores.push({ query: tc.query, expectedCount: expectedIds.length, classic: metrics(classicIds, expectedIds), physics: metrics(physicsIds, expectedIds) });
  }
  return scores;
}

function mean(scores: readonly QueryScore[], side: 'classic' | 'physics', key: keyof Metrics): number {
  return scores.reduce((sum, s) => sum + s[side][key], 0) / scores.length;
}

function logRow(s: QueryScore, by: keyof Metrics): void {
  const c = s.classic;
  const p = s.physics;
  const winner = p[by] > c[by] ? 'PHYSICS' : p[by] < c[by] ? 'CLASSIC' : 'TIE';
  console.log(
    `  ${winner.padEnd(7)} | C: P@3=${c.p3.toFixed(2)} R@3=${c.r3.toFixed(2)} MRR=${c.mrr.toFixed(2)} | ` +
    `P: P@3=${p.p3.toFixed(2)} R@3=${p.r3.toFixed(2)} MRR=${p.mrr.toFixed(2)} | ${s.query}`
  );
}

function logSummary(title: string, scores: readonly QueryScore[], by: keyof Metrics): void {
  console.log(`\n  ── ${title} ──`);
  for (const side of ['classic', 'physics'] as const) {
    console.log(`  ${side}:  P@3=${mean(scores, side, 'p3').toFixed(3)}  R@3=${mean(scores, side, 'r3').toFixed(3)}  MRR=${mean(scores, side, 'mrr').toFixed(3)}`);
  }
  const d = mean(scores, 'physics', by) - mean(scores, 'classic', by);
  console.log(`  ${by} delta: ${d >= 0 ? '+' : ''}${d.toFixed(3)}`);
}

describe('Physics vs Classic A/B Benchmark', () => {
  // Scored once, in a fixed order, before the stability test resets physics state, so no test order can move a total.
  let standard: QueryScore[] = [];
  let cluster: QueryScore[] = [];
  beforeAll(async () => {
    standard = await scoreQueries(STANDARD_QUERIES);
    cluster = await scoreQueries(CLUSTER_QUERIES);
  }, 30_000);

  describe('Standard queries', () => {
    STANDARD_QUERIES.forEach((tc, i) => {
      it(`"${tc.query}"`, () => {
        const s = standard[i]!;
        expect(s.expectedCount).toBe(tc.expectedLabels.length);
        logRow(s, 'mrr');
        expect(s.classic.mrr, `Classic MRR=0 for "${tc.query}"`).toBeGreaterThan(0);
      });
    });

    it('summary: classic BM25 ranks a right answer near the top on keyword queries', () => {
      expect(standard).toHaveLength(STANDARD_QUERIES.length);
      logSummary('Standard Queries', standard, 'mrr');
      expect(mean(standard, 'classic', 'mrr')).toBeGreaterThanOrEqual(0.8);
      expect(mean(standard, 'physics', 'mrr')).toBeGreaterThan(0);
    });
  });

  describe('Cluster queries (physics should win)', () => {
    CLUSTER_QUERIES.forEach((tc, i) => {
      it(`"${tc.query}"`, () => {
        const s = cluster[i]!;
        expect(s.expectedCount).toBe(tc.expectedLabels.length);
        logRow(s, 'r3');
        expect(s.physics.mrr, `Physics MRR=0 for "${tc.query}"`).toBeGreaterThan(0);
      });
    });

    it('summary: physics recall@3 is at least classic recall@3 on cluster queries', () => {
      expect(cluster).toHaveLength(CLUSTER_QUERIES.length);
      logSummary('Cluster Queries (Physics Advantage)', cluster, 'r3');
      expect(mean(cluster, 'physics', 'r3')).toBeGreaterThanOrEqual(mean(cluster, 'classic', 'r3'));
    });
  });

  describe('Simulation stability', () => {
    it('energy does not increase over 50 sleep cycles', () => {
      const db = openHippoDb(tmpDir);
      try {
        const entries = loadAllEntries(tmpDir);
        resetAllPhysicsState(db, entries, embeddingIndex);

        const energyHistory: number[] = [];

        for (let cycle = 0; cycle < 50; cycle++) {
          const physicsMap = loadPhysicsState(db);
          const particles = Array.from(physicsMap.values());
          if (particles.length === 0) break;

          const halfLives = new Map<string, number>();
          for (const entry of entries) halfLives.set(entry.id, entry.half_life_days);

          const ctx: ForceContext = {
            conflictPairs: new Map(),
            halfLives,
            config: DEFAULT_PHYSICS_CONFIG,
          };

          const stats = simulate(particles, ctx);
          savePhysicsState(db, particles);
          energyHistory.push(stats.energy.total);
        }

        expect(energyHistory.length).toBeGreaterThanOrEqual(10);

        const earlyAvg = energyHistory.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
        const lateAvg = energyHistory.slice(-10).reduce((a, b) => a + b, 0) / 10;

        console.log(`\n  Energy: early=${earlyAvg.toFixed(6)}, late=${lateAvg.toFixed(6)}`);
        console.log(`  Trend: ${lateAvg <= earlyAvg + 0.001 ? 'STABLE' : 'UNSTABLE'}`);

        expect(lateAvg).toBeLessThanOrEqual(earlyAvg + 0.001);
      } finally {
        closeHippoDb(db);
      }
    });
  });
});
