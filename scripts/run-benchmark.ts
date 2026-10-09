#!/usr/bin/env node
/**
 * Benchmark runner: seeds a temporary Hippo store with real lessons from MEMORY.md
 * and runs all 20 retrieval benchmark queries, printing a formatted summary table.
 *
 * Usage:
 *   npx tsx scripts/run-benchmark.ts
 *   node --import tsx/esm scripts/run-benchmark.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

import { createMemory, type MemoryEntry } from '../src/core/memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { search } from '../src/search/bm25-search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Seed data (mirrors benchmark.test.ts seed set)
// ---------------------------------------------------------------------------

const seedIds: Record<string, string> = {};

function seedMemory(
  hippoRoot: string,
  label: string,
  content: string,
  opts: Parameters<typeof createMemory>[1] = {}
): MemoryEntry {
  const entry = createMemory(content, opts);
  const withLabel: MemoryEntry = { ...entry, id: `bm_${label}` };
  writeEntry(hippoRoot, withLabel);
  seedIds[label] = withLabel.id;
  return withLabel;
}

function seedProductionRules(hippoRoot: string): void {
  seedMemory(hippoRoot, 'never_overwrite',
    `NEVER overwrite existing production files. Create versioned copies (e.g. brent_production_v5.py), keep original intact, let Keith promote.`,
    { tags: ['production', 'rule', 'critical'], emotional_valence: 'critical', pinned: true });

  seedMemory(hippoRoot, 'version_files',
    `Version production files before modifying. Always create backup (e.g. gold_production_v4.py) before touching production_*.py files.`,
    { tags: ['production', 'rule', 'versioning'] });

  seedMemory(hippoRoot, 'no_emoji_python',
    `No emoji in Python print statements on Windows. cp1252 encoding crashes on emoji. Example: print("✅ Success!") crashes. Use plain ASCII: print("OK").`,
    { tags: ['platform', 'windows', 'encoding', 'error'], emotional_valence: 'negative' });

  seedMemory(hippoRoot, 'powershell_semicolons',
    `PowerShell uses semicolons not && to chain commands. Correct: npm run build; npx wrangler deploy. Wrong: npm run build && npx wrangler deploy.`,
    { tags: ['platform', 'powershell', 'windows', 'error'], emotional_valence: 'negative' });
}

function seedDataPipeline(hippoRoot: string): void {
  seedMemory(hippoRoot, 'fred_cache_drop',
    `FRED cache can silently drop series. tips_10y (DFII10) vanished from fred_weekly.parquet, breaking the gold model. Always verify cache contents after refresh failures.`,
    { tags: ['data-pipeline', 'fred', 'error', 'gold-model'], emotional_valence: 'negative' });

  seedMemory(hippoRoot, 'fred_fallback',
    `Use FRED as fallback for dead data URLs. IMF and FAO data went 404; same indices on FRED (PALLFNFINDEXM, PFOODINDEXM). FRED is more reliable than scraping websites.`,
    { tags: ['data-pipeline', 'fred', 'imf', 'fao'] });

  seedMemory(hippoRoot, 'eia_path_change',
    `EIA API path changed silently. /petroleum/sum/wkly became /petroleum/sum/sndw. Broke 9 of 10 EIA series because exceptions were swallowed. Always log failed API calls.`,
    { tags: ['data-pipeline', 'eia', 'api', 'error'], emotional_valence: 'negative' });

  seedMemory(hippoRoot, 'staleness_hides_ok',
    `Data source staleness hides behind "OK" reports. Cache refresh reported "14/14 OK" while 5+ sources were silently stale. Always verify actual data, not just the exit code.`,
    { tags: ['data-pipeline', 'staleness', 'monitoring', 'error'], emotional_valence: 'negative' });

  seedMemory(hippoRoot, 'wb_column_names',
    `WB Pink Sheet column names must be preserved exactly ("Coconut oil", "Wheat, US SRW", "DAP"). Never rename without checking all 24 production models.`,
    { tags: ['data-pipeline', 'world-bank', 'columns', 'error'], emotional_valence: 'negative' });

  seedMemory(hippoRoot, 'cache_column_mismatch',
    `Cache column mismatches break models silently. Columns dbc, slx, uup, tips_10y not in daily_cache_refresh.py — models return None signal. Cross-check all production model column references.`,
    { tags: ['data-pipeline', 'cache', 'columns', 'error'], emotional_valence: 'negative' });

  seedMemory(hippoRoot, 'fred_column_alias',
    `FRED column alias map: tips_10y->compute(ust_10y-breakeven_10y), yield_curve_3m->yield_curve_10y3m, usdbrl_fred->brlusd, henryhub_spot->henry_hub, wti_spot->wti_fred.`,
    { tags: ['data-pipeline', 'fred', 'columns', 'alias'] });
}

function seedSubagentGotchas(hippoRoot: string): void {
  seedMemory(hippoRoot, 'subagent_american_english',
    `Sub-agents use American English. Review before deploying: favorable->favourable, maximize->maximise. Also invalid UI colours: teal, orange, pink not allowed.`,
    { tags: ['sub-agent', 'review', 'spelling', 'ui'] });

  seedMemory(hippoRoot, 'subagent_slop_words',
    `Sub-agents produce slop words: comprehensive, robust, leverage, harness, tapestry, landscape, compelling. Review all agent text before deploying.`,
    { tags: ['sub-agent', 'review', 'copywriting', 'slop'] });

  seedMemory(hippoRoot, 'subagent_fabrication',
    `Verify sub-agent model metrics before accepting. Natgas V3 claimed Min Sharpe 0.99->1.60; actual CV=-0.73. Manifest was falsified. Always run the backtest script to verify.`,
    { tags: ['sub-agent', 'verification', 'metrics', 'error', 'critical'], emotional_valence: 'critical' });

  seedMemory(hippoRoot, 'subagent_novel_data',
    `Suggest novel data sources proactively: NDVI, satellite data, soil moisture, sea surface temps. Don't default to conventional financial/macro sources only.`,
    { tags: ['sub-agent', 'data-sources', 'creativity'] });
}

function seedQuantLessons(hippoRoot: string): void {
  seedMemory(hippoRoot, 'walk_forward_overestimates',
    `Walk-forward OOS Sharpe overestimates by ~50%. CPCV Exp 7: mean WF=1.15 vs CPCV=0.56 (+0.59 avg). Use CPCV-deflated Sharpe for honest reporting.`,
    { tags: ['quant', 'backtest', 'sharpe', 'cpcv', 'walk-forward'] });

  seedMemory(hippoRoot, 'oos_split_distinction',
    `Walk-Forward OOS vs Holdout OOS are different. Walk-forward: 18 years rolling predictions. Holdout: 6 years (2020-2026) no hyperparameter tuning. oos_start is the holdout split.`,
    { tags: ['quant', 'backtest', 'oos', 'walk-forward', 'holdout'] });

  seedMemory(hippoRoot, 'data_mining_honesty',
    `Data mining: selected features on ALL data, reported as OOS. Fix: economic theory features only, or select on train set, freeze, test on held-out data. Honest Sharpe: 0.87 not 1.74.`,
    { tags: ['quant', 'data-mining', 'feature-selection', 'backtest', 'error'], emotional_valence: 'negative' });

  seedMemory(hippoRoot, 'equal_weight_beats_optimization',
    `Equal weight 1/N beats portfolio optimization. Exp 9: 1/N Sharpe 3.12 matches or beats all optimization schemes. Don't bother optimizing portfolio weights.`,
    { tags: ['quant', 'portfolio', 'optimization', 'equal-weight'] });

  seedMemory(hippoRoot, 'natgas_gfc_period',
    `Natgas 2008-2009 GFC tanks CV. 2008 Sharpe=-1.89, 2009=-1.54. GFC broke natgas pricing relationships. With 2020 OOS split: CV=0.57, OOS=0.92.`,
    { tags: ['quant', 'natgas', 'backtest', 'gfc', 'regime'] });

  seedMemory(hippoRoot, 'natgas_v4_details',
    `Natgas V4: 18 features, Min Sharpe 1.08. Config tw=78, rw=26, C=0.20. 2008 GFC fixed from -1.89 to +2.50 via macro regime features. 19/23 positive years. Inception: 2026-02-06.`,
    { tags: ['quant', 'natgas', 'model', 'v4', 'production'] });

  seedMemory(hippoRoot, 'cpcv_deflation',
    `CPCV deflation needed for honest Sharpe reporting. Walk-forward inflates by ~50%. Use CPCV-deflated Sharpe for risk management and sizing decisions.`,
    { tags: ['quant', 'cpcv', 'sharpe', 'risk'] });
}

function seedFrontendAndOps(hippoRoot: string): void {
  // Frontend/deploy
  seedMemory(hippoRoot, 'build_before_deploy',
    `Always run npm run build before deploying frontend. Deploy command: npx wrangler pages deploy out --project-name=project-e. Missing build step deploys stale code.`,
    { tags: ['frontend', 'deploy', 'build'] });

  seedMemory(hippoRoot, 'constants_must_sync',
    `Frontend/backend constants must sync: production/shared_constants.py <-> trading-constants.ts. RISK_PER_TRADE changes must go in BOTH files. Mismatch = wrong sizing.`,
    { tags: ['frontend', 'backend', 'constants', 'sync', 'error'], emotional_valence: 'negative' });

  // Ops
  seedMemory(hippoRoot, 'cron_timeout_sizing',
    `Cron timeout sizing: memory+file edit+commit/push tasks need >=900s timeout. Run one manual timed pass, then set timeout to 2x observed runtime.`,
    { tags: ['ops', 'cron', 'timeout', 'scheduling'] });

  seedMemory(hippoRoot, 'alternative_data_sources',
    `Alternative data sources for commodity models: NDVI, satellite imagery, soil moisture, sea surface temperatures, shipping AIS. Don't only suggest conventional financial/macro data.`,
    { tags: ['data-sources', 'alternative', 'quant', 'commodities'] });
}

function buildSeedSet(hippoRoot: string): void {
  seedProductionRules(hippoRoot);
  seedDataPipeline(hippoRoot);
  seedSubagentGotchas(hippoRoot);
  seedQuantLessons(hippoRoot);
  seedFrontendAndOps(hippoRoot);
}

// ---------------------------------------------------------------------------
// Benchmark queries (mirrors benchmark.test.ts)
// ---------------------------------------------------------------------------

interface QueryCase {
  query: string;
  expectedLabels: string[];
}

const TEST_CASES: QueryCase[] = [
  { query: 'why is gold model broken', expectedLabels: ['fred_cache_drop', 'cache_column_mismatch', 'fred_column_alias'] },
  { query: 'deploying to production', expectedLabels: ['build_before_deploy', 'version_files', 'never_overwrite'] },
  { query: 'python print crashes on windows', expectedLabels: ['no_emoji_python'] },
  { query: 'sub-agent output review', expectedLabels: ['subagent_american_english', 'subagent_slop_words', 'subagent_fabrication'] },
  { query: 'data refresh failed', expectedLabels: ['fred_cache_drop', 'eia_path_change', 'wb_column_names', 'staleness_hides_ok'] },
  { query: 'backtest results seem too good', expectedLabels: ['walk_forward_overestimates', 'data_mining_honesty', 'cpcv_deflation'] },
  { query: 'modifying production model file', expectedLabels: ['never_overwrite', 'version_files'] },
  { query: 'natgas model performance history', expectedLabels: ['natgas_gfc_period', 'natgas_v4_details'] },
  { query: 'frontend deploy process build', expectedLabels: ['build_before_deploy', 'constants_must_sync', 'powershell_semicolons'] },
  { query: 'PowerShell command chaining operators', expectedLabels: ['powershell_semicolons'] },
  { query: 'cache column missing broken', expectedLabels: ['cache_column_mismatch', 'fred_column_alias', 'wb_column_names'] },
  { query: 'what is OOS split holdout', expectedLabels: ['oos_split_distinction', 'walk_forward_overestimates'] },
  { query: 'FRED data stale or missing', expectedLabels: ['fred_cache_drop', 'fred_fallback', 'staleness_hides_ok'] },
  { query: 'emoji in output crashes', expectedLabels: ['no_emoji_python'] },
  { query: 'model metrics look wrong fabricated', expectedLabels: ['subagent_fabrication', 'walk_forward_overestimates'] },
  { query: 'equal weight versus portfolio optimization', expectedLabels: ['equal_weight_beats_optimization'] },
  { query: 'new data source ideas for commodities', expectedLabels: ['subagent_novel_data', 'alternative_data_sources'] },
  { query: 'EIA API broken path', expectedLabels: ['eia_path_change', 'staleness_hides_ok'] },
  { query: 'feature selection method avoiding data mining', expectedLabels: ['data_mining_honesty'] },
  { query: 'scheduling cron jobs timeout size', expectedLabels: ['cron_timeout_sizing'] },
];

// ---------------------------------------------------------------------------
// Metric functions
// ---------------------------------------------------------------------------

function precision3(topIds: string[], expectedIds: string[]): number {
  return topIds.slice(0, 3).filter((id) => expectedIds.includes(id)).length / 3;
}

function recall3(topIds: string[], expectedIds: string[]): number {
  if (expectedIds.length === 0) return 1;
  return topIds.slice(0, 3).filter((id) => expectedIds.includes(id)).length / expectedIds.length;
}

function mrr(topIds: string[], expectedIds: string[]): number {
  for (let i = 0; i < Math.min(topIds.length, 10); i++) {
    if (expectedIds.includes(topIds[i])) return 1 / (i + 1);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-bench-script-'));

  try {
    initStore(tmpDir);
    buildSeedSet(tmpDir);

    const entries = loadAllEntries(tmpDir);
    console.log(`\n🦛 Hippo Retrieval Benchmark`);
    console.log(`   Memories seeded: ${entries.length}`);
    console.log(`   Queries:         ${TEST_CASES.length}\n`);

    // Header
    const col1 = 45;
    const col2 = 6;
    const col3 = 8;
    const col4 = 6;
    const divider = '─'.repeat(col1 + col2 + col3 + col4 + 10);

    console.log(
      `${'Query'.padEnd(col1)} ${'P@3'.padEnd(col2)} ${'Recall@3'.padEnd(col3)} ${'MRR'.padEnd(col4)}`
    );
    console.log(divider);

    let totalP3 = 0, totalR3 = 0, totalMRR = 0;

    for (const tc of TEST_CASES) {
      const expectedIds = tc.expectedLabels.map((l) => seedIds[l]).filter(Boolean);
      const results = search(tc.query, entries, { budget: 8000 });
      const topIds = results.slice(0, 10).map((r) => r.entry.id);

      const p3 = precision3(topIds, expectedIds);
      const r3 = recall3(topIds, expectedIds);
      const m = mrr(topIds, expectedIds);

      totalP3 += p3;
      totalR3 += r3;
      totalMRR += m;

      const mrrStr = m === 0 ? '0.00 ❌' : m.toFixed(2) + (m >= 0.5 ? ' ✓' : ' ~');
      const truncQuery = tc.query.length > col1 - 1 ? tc.query.slice(0, col1 - 4) + '...' : tc.query;

      console.log(
        `${truncQuery.padEnd(col1)} ${p3.toFixed(2).padEnd(col2)} ${r3.toFixed(2).padEnd(col3)} ${mrrStr}`
      );
    }

    const n = TEST_CASES.length;
    const avgP3 = totalP3 / n;
    const avgR3 = totalR3 / n;
    const avgMRR = totalMRR / n;

    console.log(divider);
    console.log(
      `${'AVERAGE'.padEnd(col1)} ${avgP3.toFixed(2).padEnd(col2)} ${avgR3.toFixed(2).padEnd(col3)} ${avgMRR.toFixed(2)}`
    );
    console.log('');
    console.log(`📊 Summary:`);
    console.log(`   Avg Precision@3: ${avgP3.toFixed(3)} (${(avgP3 * 100).toFixed(1)}%)`);
    console.log(`   Avg Recall@3:    ${avgR3.toFixed(3)} (${(avgR3 * 100).toFixed(1)}%)`);
    console.log(`   Avg MRR:         ${avgMRR.toFixed(3)}`);
    console.log(`   Overall grade:   ${avgMRR >= 0.7 ? '🟢 GOOD' : avgMRR >= 0.5 ? '🟡 OK' : '🔴 POOR'}\n`);

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
