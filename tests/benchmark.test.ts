/**
 * Retrieval Quality Benchmark for Hippo.
 *
 * Seeds 50+ real memories from MEMORY.md (lessons learned in production)
 * and validates that natural-language queries surface the right memories.
 *
 * Metrics per query:
 *   Precision@3 - of top-3 results, fraction that were expected
 *   Recall@3    - of expected IDs, fraction that appeared in top-3
 *   MRR         - 1/rank of first correct result (0 if none in top-10)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createMemory,
  calculateStrength,
  applyOutcome,
  Layer,
  type MemoryEntry,
} from '../src/memory.js';
import {
  initStore,
  writeEntry,
  loadAllEntries,
} from '../src/store.js';
import { search, markRetrieved, estimateTokens } from '../src/search.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
const seedIds: Record<string, string> = {}; // label -> id

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Write a memory and record its id under a stable label. */
function seed(
  label: string,
  content: string,
  opts: Parameters<typeof createMemory>[1] = {}
): MemoryEntry {
  const entry = createMemory(content, opts);
  // Use label as a deterministic ID fragment so tests are readable
  const withLabel: MemoryEntry = { ...entry, id: `bm_${label}` };
  writeEntry(tmpDir, withLabel);
  seedIds[label] = withLabel.id;
  return withLabel;
}

// ---------------------------------------------------------------------------
// Seed memories (real lessons from MEMORY.md)
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-bench-'));
  initStore(tmpDir);

  // ── Production rules ──────────────────────────────────────────────────────
  seed('never_overwrite', `NEVER overwrite existing production files. When improving a model:
1. Create a new versioned file (e.g. brent_production_v5.py)
2. Keep the original intact
3. Let Keith decide when to promote/replace
Violating this destroys live PnL history.`, {
    tags: ['production', 'rule', 'critical'],
    emotional_valence: 'critical',
    pinned: true,
  });

  seed('version_files', `Version production files before modifying. Always create a backup copy
(e.g. gold_production_v4.py) before touching production_*.py files. Never in-place edit.
Natgas V3 was overwritten without versioning; the only recovery was git log.`, {
    tags: ['production', 'rule', 'versioning'],
  });

  seed('no_emoji_python', `No emoji in Python print statements on Windows. cp1252 encoding
crashes on emoji characters. Example crash: print("✅ Success!"). Use plain ASCII:
print("OK") or print("[OK]"). Affects all Windows Python scripts including data refresh.`, {
    tags: ['platform', 'windows', 'encoding', 'error'],
    emotional_valence: 'negative',
  });

  seed('powershell_semicolons', `PowerShell uses semicolons not && to chain commands.
Correct: npm run build; npx wrangler deploy
Wrong:   npm run build && npx wrangler deploy
The && operator causes silent failure in PowerShell; use ; instead.`, {
    tags: ['platform', 'powershell', 'windows', 'error'],
    emotional_valence: 'negative',
  });

  // ── Data pipeline errors ──────────────────────────────────────────────────
  seed('fred_cache_drop', `FRED cache can silently drop series. tips_10y (DFII10) vanished from
fred_weekly.parquet during daily refresh, breaking the gold model. Always verify cache contents
after refresh failures. The data_fetchers.py mapping exists but the fetcher may silently skip series.`, {
    tags: ['data-pipeline', 'fred', 'error', 'gold-model'],
    emotional_valence: 'negative',
  });

  seed('fred_fallback', `FRED as fallback for dead data URLs. IMF External_Data.xlsx and FAO food price
CSV both went 404 in 2025-2026. The same indices are available on FRED (PALLFNFINDEXM, PNRGINDEXM,
PFOODINDEXM, PMETAINDEXM). FRED is more reliable than scraping institutional websites.`, {
    tags: ['data-pipeline', 'fred', 'imf', 'fao'],
  });

  seed('eia_path_change', `EIA API path changed silently. /petroleum/sum/wkly became /petroleum/sum/sndw.
NatGas at /natural-gas/stor/wkly was unaffected. This broke 9 of 10 EIA series silently because
exceptions were swallowed. Always log failed API calls, don't just pass.`, {
    tags: ['data-pipeline', 'eia', 'api', 'error'],
    emotional_valence: 'negative',
  });

  seed('staleness_hides_ok', `Data source staleness can hide behind OK reports. Daily cache refresh
reported "14/14 OK" while 5+ sources were silently stale (WB date format change, DBnomics stuck at
2023, IndexMundi SSL expired, Drought Monitor API redesigned, EIA path change). Always verify the
actual data, not just the exit code. Added staleness checker that flags parquets >14 days old.`, {
    tags: ['data-pipeline', 'staleness', 'monitoring', 'error'],
    emotional_valence: 'negative',
  });

  seed('wb_column_names', `WB Pink Sheet column names must be preserved exactly. Production models
reference original column names like "Coconut oil", "Wheat, US SRW", "DAP". Never rename or prefix
WB Pink Sheet columns without checking all 24 production models first. Silent column mismatch returns
None signal instead of erroring.`, {
    tags: ['data-pipeline', 'world-bank', 'columns', 'error'],
    emotional_valence: 'negative',
  });

  seed('cache_column_mismatch', `Cache column mismatches break models silently. Production models
reference columns (dbc, slx, uup, tips_10y) that weren't in daily_cache_refresh.py's series maps.
Models return None signal instead of erroring. Cross-check: scan all *_production_std.py for
yf["col"]/fred["col"] references and verify they exist in the cache parquets.`, {
    tags: ['data-pipeline', 'cache', 'columns', 'error'],
    emotional_valence: 'negative',
  });

  seed('fred_column_alias', `FRED cache column alias map. Production models reference names that differ
from fred cache keys:
- tips_10y -> compute ust_10y - breakeven_10y
- yield_curve_3m -> yield_curve_10y3m
- usdbrl_fred -> brlusd
- henryhub_spot -> henry_hub
- wti_spot -> wti_fred
- dxy_broad -> usd_broad
- brent_spot -> brent_fred
Always check this mapping when adding FRED features.`, {
    tags: ['data-pipeline', 'fred', 'columns', 'alias'],
  });

  seed('daily_refresh_incomplete', `daily_cache_refresh.py does NOT refresh all sources. It does NOT
refresh etf_flows_weekly.parquet or shipping_freight_weekly.parquet. Those are handled by
scripts/pull_new_sources.py. Don't expect daily_cache_refresh to update those files.`, {
    tags: ['data-pipeline', 'cache', 'refresh'],
  });

  seed('gogl_delisted', `GOGL delisted  - returned 404 during shipping refresh. Remaining shipping tickers
(BDRY/BOAT/SEA/SBLK) are fine. Remove GOGL from any shipping data pull scripts.`, {
    tags: ['data-pipeline', 'shipping', 'delisted'],
  });

  // ── Sub-agent gotchas ─────────────────────────────────────────────────────
  seed('subagent_american_english', `Sub-agents consistently use American English spelling. Review all
sub-agent output before deploying: favorable (→ favourable), maximize (→ maximise), optimize
(→ optimise), color (→ colour). Also check for invalid UI colour values like teal, orange, pink
instead of allowed values: blue/green/purple/red/yellow/coral/violet/ocean/amber.`, {
    tags: ['sub-agent', 'review', 'spelling', 'ui'],
  });

  seed('subagent_slop_words', `Sub-agents produce AI slop words that must be removed before deploying.
Common offenders: comprehensive, robust, leverage, harness, tapestry, landscape, compelling.
Always review sub-agent text output for these before deploying. If it sounds like a LinkedIn post
you'd scroll past, rewrite it.`, {
    tags: ['sub-agent', 'review', 'copywriting', 'slop'],
  });

  seed('subagent_fabrication', `Always verify sub-agent model metrics before accepting. Natgas V3
(commit b99c890) by Claude Code claimed Min Sharpe 0.99 -> 1.60 (+62%). Actual: CV=-0.73.
The commit message and PRODUCTION_MANIFEST were both falsified. Always run
python production/{commodity}_production_std.py and compare output to claimed metrics.`, {
    tags: ['sub-agent', 'verification', 'metrics', 'error', 'critical'],
    emotional_valence: 'critical',
  });

  seed('subagent_novel_data', `Suggest novel data sources proactively. Keith asked many times what data
to pull and I kept suggesting conventional financial/macro sources. Never mentioned NDVI, satellite data,
soil moisture, sea surface temps, or other alternative data until Keith asked directly.
Think beyond the obvious when suggesting data sources.`, {
    tags: ['sub-agent', 'data-sources', 'creativity'],
  });

  // ── Quant model lessons ───────────────────────────────────────────────────
  seed('walk_forward_overestimates', `Walk-forward OOS Sharpe overestimates by ~50%. CPCV experiment
(Exp 7) showed walk-forward OOS Sharpe overestimates by +0.59 on average (mean WF=1.15 vs CPCV=0.56).
PBO is low (10.7%) so models aren't overfit, but single-path WF gives an optimistic view.
Use CPCV-deflated Sharpe for risk management and honest reporting.`, {
    tags: ['quant', 'backtest', 'sharpe', 'cpcv', 'walk-forward'],
  });

  seed('oos_split_distinction', `Walk-Forward OOS vs Holdout OOS are different things. Quantamental
models have TWO layers of OOS protection:
1. Walk-forward OOS (~18 years): every prediction is on unseen data (rolling train window)
2. Holdout OOS (6 years, 2020-2026): period where NO hyperparameters/thresholds were tuned
Don't conflate them. The oos_start config field is the holdout split, not where OOS predictions begin.`, {
    tags: ['quant', 'backtest', 'oos', 'walk-forward', 'holdout'],
  });

  seed('data_mining_honesty', `Data mining honesty: I was "testing features without data mining" but
actually WAS data mining. Selected features by testing on ALL data, then claimed good OOS results.
The fix:
1. Select features based on ECONOMIC THEORY only (no performance testing)
2. OR select on early data, freeze, test on later data (never peek)
3. Run ONCE, accept the result  - no iteration based on backtest results
Honest results (theory-only 6 features): Sharpe 0.87, not 1.02 or 1.74.`, {
    tags: ['quant', 'data-mining', 'feature-selection', 'backtest', 'error'],
    emotional_valence: 'negative',
  });

  seed('equal_weight_beats_optimization', `Equal weight beats portfolio optimization. Exp 9 confirmed
(Trend Premia 2025): equal-weight 1/N allocation (Sharpe 3.12) matches or beats all optimization
schemes tested. Don't bother optimizing portfolio weights. 1/N is simpler, more robust, and
performs as well or better than Markowitz variants.`, {
    tags: ['quant', 'portfolio', 'optimization', 'equal-weight'],
  });

  seed('natgas_gfc_period', `Natgas 2008-2009 GFC period tanks CV. Year-by-year: 2008 Sharpe=-1.89,
2009=-1.54. Everything else is positive. With 2015 OOS split: CV=0.10, OOS=1.01. With 2020 split:
CV=0.57, OOS=0.92. Fundamental problem: GFC broke natgas pricing relationships. Regime features
needed to handle this period.`, {
    tags: ['quant', 'natgas', 'backtest', 'gfc', 'regime'],
  });

  seed('natgas_v4_details', `Natgas V4 deployed (18 features, Min Sharpe 1.08). Full rebuild from V2
baseline. 134 unique features tested via forward selection. 18 selected. Config: tw=78, rw=26,
C=0.20, lt=0.575, st=0.44. 19/23 positive years. 2008 GFC fixed from -1.89 to +2.50 via macro
regime features. Inception date: 2026-02-06. Commits: 5db27c3, e2dc118, 65d5df8.`, {
    tags: ['quant', 'natgas', 'model', 'v4', 'production'],
  });

  seed('proxy_features_wrong', `NEVER use proxy features for paper experiments. Simplified proxy
features (3 generic features per commodity) gave completely wrong results. XGBoost appeared to beat
LogReg 10/17 with proxy features, but LogReg actually wins 10/17 with real production features.
Always use paper/extract_production_data.py to capture actual X, y from production models.`, {
    tags: ['quant', 'features', 'proxy', 'error', 'paper'],
    emotional_valence: 'negative',
  });

  seed('backtest_engine_refactor', `Backtest engine refactor changed model scores. V2 manifest claimed
CV=0.99, but running the same V2 features on the current shared backtest_engine gives CV=0.10. The
refactored walk-forward implementation produces different results. Likely old engine had train/test
overlap (V2 commit mentions fixing this). Always re-run after engine changes.`, {
    tags: ['quant', 'backtest', 'engine', 'regression'],
  });

  seed('production_models_not_uniform', `Production models are NOT uniform. Models vary: 39w-130w
training windows, 4w-52w retrain cycles, C=0.03-0.75 regularization, 4-25 features. Don't assume
"78-week fixed window" or "C=0.15" in experiments or paper text. Check PROD_CONFIG or scan the
actual files before making any assumptions about model configuration.`, {
    tags: ['quant', 'production', 'config', 'models'],
  });

  seed('cpcv_deflation', `CPCV deflation needed for honest Sharpe reporting. Walk-forward inflates
Sharpe by ~50% on average. CPCV (Combinatorial Purged Cross-Validation) gives a better estimate
of true OOS performance. For risk management and sizing decisions, always use CPCV-deflated Sharpe,
not raw walk-forward numbers.`, {
    tags: ['quant', 'cpcv', 'sharpe', 'risk'],
  });

  seed('ml_based_models_count', `22 of 25 production models are ML-based. 3 permanently excluded:
heatingoil + gasoline (rule-based, no logistic regression), carbon (no yfinance price series).
All others use walk_forward_predict with LogisticRegression.`, {
    tags: ['quant', 'production', 'models', 'ml'],
  });

  seed('stored_pnl_no_recalculate', `Never recalculate stored PnL data without explicit approval.
The bt_production_*.csv files use uniform 4-lot positions. Don't use these for LinkedIn posts or
any public-facing PnL claims. Historical live PnL is sacrosanct; never overwrite it.`, {
    tags: ['quant', 'production', 'pnl', 'critical'],
    emotional_valence: 'critical',
  });

  // ── Frontend/deploy rules ─────────────────────────────────────────────────
  seed('build_before_deploy', `Always run build before deploying frontend. Build command:
cd C:/Users/skf_s/quantamental/website/frontend; npm run build
Deploy command: npx wrangler pages deploy out --project-name=quantamental
Missing the build step deploys stale code. The dist/ directory is gitignored.`, {
    tags: ['frontend', 'deploy', 'build'],
  });

  seed('constants_must_sync', `Frontend and backend trading constants must stay in sync.
Shared constants: production/shared_constants.py <-> website/frontend/src/lib/trading-constants.ts
Any change to RISK_PER_TRADE, position sizing, or signal thresholds must be updated in BOTH files.
Mismatch causes silent wrong sizing on the frontend dashboard.`, {
    tags: ['frontend', 'backend', 'constants', 'sync', 'error'],
    emotional_valence: 'negative',
  });

  seed('frontend_reasoning_text', `Frontend reasoning text must reflect actual features. Softs SHORT
reasoning said "growing conditions" but no model uses weather/crop data. Don't write reasoning text
that implies features that don't exist. Check PROD_CONFIG for actual features before writing copy.`, {
    tags: ['frontend', 'copywriting', 'features', 'accuracy'],
  });

  seed('field_name_mapping', `update_frontend_data.py field name mapping. live_signal.json uses
direction (LONG/SHORT/FLAT). update_frontend_data.py was reading signal/signal_label which don't
exist. Fixed to map direction -> numeric + label. Check this mapping if signal format changes.`, {
    tags: ['frontend', 'data-pipeline', 'field-names'],
  });

  // ── Platform / ops issues ─────────────────────────────────────────────────
  seed('cron_timeout_sizing', `Cron timeout sizing for heavy jobs. If a cron task must read
transcripts/memory and then edit files + commit/push, default to >=900s timeout. Run one manual
timed pass before enabling the schedule, then size timeout to at least 2x observed runtime.
If a run times out, pause retries until timeout is fixed. Don't burn cycles on known-bad limits.`, {
    tags: ['ops', 'cron', 'timeout', 'scheduling'],
  });

  seed('pre_run_data_check_exit_code', `pre_run_data_check.py exit code ambiguity. The script
appears to return exit code 1 in a warnings-only state (no critical blockers). Exit-code handling
likely needs review to distinguish warnings from failures. Don't treat exit code 1 as a hard
failure until this is clarified.`, {
    tags: ['ops', 'data-pipeline', 'exit-code', 'monitoring'],
  });

  seed('gateway_install_requires_admin', `OpenClaw gateway install requires Administrator PowerShell.
openclaw gateway install --force requires elevated shell (schtasks: Access is denied when not elevated).
Regular start/stop/restart are fine without elevation.`, {
    tags: ['ops', 'openclaw', 'admin', 'windows'],
  });

  seed('friday_time_guards', `Friday quant cron jobs have hard time guards: only run 20:30-22:30
Europe/London on Friday. Outside that window they return SKIP: outside Friday settlement window.
This prevents stale catch-up runs after gateway restarts.`, {
    tags: ['ops', 'cron', 'scheduling', 'quant'],
  });

  seed('gsc_reauth', `GSC CLI needs re-auth periodically. GSC invalid_grant error means refresh token
expired or revoked. Fresh gsc_query.py run will require re-auth. Site property: sc-domain:boring-math.com.`, {
    tags: ['ops', 'gsc', 'auth'],
  });

  seed('max_concurrent_subagents', `Max concurrent sub-agents is 2. Machine has 16GB RAM. 3+ agents
causes gateway crashes (learned 2026-02-27). Always confirm how many agents are running before
spawning a new one.`, {
    tags: ['ops', 'sub-agent', 'memory', 'concurrency'],
  });

  seed('alternative_data_sources', `Alternative data sources for commodity models: NDVI (crop
health), satellite imagery, soil moisture indices, sea surface temperatures, shipping AIS data.
Don't default to conventional financial/macro sources only. These non-traditional signals can add
real predictive value that's uncorrelated with standard factors.`, {
    tags: ['data-sources', 'alternative', 'quant', 'commodities'],
  });

  seed('node_llama_cpp_install', `node-llama-cpp requires manual install. It's an optional ESM
dependency that npm skips during npm install. Must install manually:
cd C:/Users/skf_s/AppData/Roaming/npm/node_modules/openclaw; npm i node-llama-cpp
Verify with dynamic import, not require().`, {
    tags: ['ops', 'openclaw', 'install', 'llm'],
  });

  seed('context_limit_compact', `Suggest /compact when context > 60%. Sub-agents on long tasks
should write intermediate results to disk (scratchpad file or task state YAML). Each step reads
from disk, not from conversation history. Keeps context focused and prevents compaction loss.`, {
    tags: ['ops', 'context', 'sub-agent', 'memory'],
  });

  seed('x_posting_antispam', `X/Twitter posting anti-spam: boring-math account was flagged for spam.
Cut from hourly (16 runs/day, 5 replies each = ~80 posts) to 3x daily at irregular times
(9:23, 14:23, 20:23), 2 replies + 1 original per run (~9 posts/day).`, {
    tags: ['social', 'twitter', 'spam', 'cron'],
  });

  seed('boring_maths_url', `boring-math.com correct URL format: https://boring-math.com/calculators/{name}
NOT: https://www.boring-math.com/{name}. Always use this exact format when linking to calculators.`, {
    tags: ['boring-maths', 'url', 'seo'],
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

interface QueryCase {
  query: string;
  expectedLabels: string[]; // seed labels that should appear in top-3
}

function runQuery(query: string, n = 10): string[] {
  const entries = loadAllEntries(tmpDir);
  const results = search(query, entries, { budget: 8000 });
  return results.slice(0, n).map((r) => r.entry.id);
}

function precision3(topIds: string[], expectedIds: string[]): number {
  const hits = topIds.slice(0, 3).filter((id) => expectedIds.includes(id)).length;
  return hits / 3;
}

function recall3(topIds: string[], expectedIds: string[]): number {
  if (expectedIds.length === 0) return 1;
  const hits = topIds.slice(0, 3).filter((id) => expectedIds.includes(id)).length;
  return hits / expectedIds.length;
}

function mrr(topIds: string[], expectedIds: string[]): number {
  for (let i = 0; i < topIds.slice(0, 10).length; i++) {
    if (expectedIds.includes(topIds[i])) return 1 / (i + 1);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Retrieval quality test cases
// ---------------------------------------------------------------------------

const TEST_CASES: QueryCase[] = [
  {
    query: 'why is gold model broken',
    expectedLabels: ['fred_cache_drop', 'cache_column_mismatch', 'fred_column_alias'],
  },
  {
    query: 'deploying to production',
    expectedLabels: ['build_before_deploy', 'version_files', 'never_overwrite'],
  },
  {
    query: 'python print crashes on windows',
    expectedLabels: ['no_emoji_python'],
  },
  {
    query: 'sub-agent output review',
    expectedLabels: ['subagent_american_english', 'subagent_slop_words', 'subagent_fabrication'],
  },
  {
    query: 'data refresh failed',
    expectedLabels: ['fred_cache_drop', 'eia_path_change', 'wb_column_names', 'staleness_hides_ok'],
  },
  {
    query: 'backtest results seem too good',
    expectedLabels: ['walk_forward_overestimates', 'data_mining_honesty', 'cpcv_deflation'],
  },
  {
    query: 'modifying production model file',
    expectedLabels: ['never_overwrite', 'version_files'],
  },
  {
    query: 'natgas model performance history',
    expectedLabels: ['natgas_gfc_period', 'natgas_v4_details'],
  },
  {
    query: 'frontend deploy process build',
    expectedLabels: ['build_before_deploy', 'constants_must_sync', 'powershell_semicolons'],
  },
  {
    query: 'PowerShell command chaining operators',
    expectedLabels: ['powershell_semicolons'],
  },
  {
    query: 'cache column missing broken',
    expectedLabels: ['cache_column_mismatch', 'fred_column_alias', 'wb_column_names'],
  },
  {
    query: 'what is OOS split holdout',
    expectedLabels: ['oos_split_distinction', 'walk_forward_overestimates'],
  },
  {
    query: 'FRED data stale or missing',
    expectedLabels: ['fred_cache_drop', 'fred_fallback', 'staleness_hides_ok'],
  },
  {
    query: 'emoji in output crashes',
    expectedLabels: ['no_emoji_python'],
  },
  {
    query: 'model metrics look wrong fabricated',
    expectedLabels: ['subagent_fabrication', 'walk_forward_overestimates'],
  },
  {
    query: 'equal weight versus portfolio optimization',
    expectedLabels: ['equal_weight_beats_optimization'],
  },
  {
    query: 'new data source ideas for commodities',
    expectedLabels: ['subagent_novel_data', 'alternative_data_sources'],
  },
  {
    query: 'EIA API broken path',
    expectedLabels: ['eia_path_change', 'staleness_hides_ok'],
  },
  {
    query: 'feature selection method avoiding data mining',
    expectedLabels: ['data_mining_honesty', 'proxy_features_wrong'],
  },
  {
    query: 'scheduling cron jobs timeout size',
    expectedLabels: ['cron_timeout_sizing', 'friday_time_guards'],
  },
];

describe('Retrieval quality benchmark', () => {
  it('has all seed memories written to the store', () => {
    const entries = loadAllEntries(tmpDir);
    // We seed >30 memories explicitly above
    expect(entries.length).toBeGreaterThanOrEqual(30);
  });

  // Run each query and assert MRR > 0 (at least one correct result in top-10)
  for (const tc of TEST_CASES) {
    it(`query: "${tc.query}"`, () => {
      const expectedIds = tc.expectedLabels.map((l) => seedIds[l]).filter(Boolean);
      expect(expectedIds.length).toBeGreaterThan(0); // sanity check all labels exist

      const topIds = runQuery(tc.query);
      const m = mrr(topIds, expectedIds);
      const p3 = precision3(topIds, expectedIds);

      // At minimum we want MRR > 0  - something relevant in the top-10
      expect(m, `MRR=0 for query "${tc.query}". Top results: ${topIds.slice(0,3).join(', ')}`).toBeGreaterThan(0);

      // Log for visibility (doesn't fail)
      console.log(
        `  P@3=${p3.toFixed(2)} Recall@3=${recall3(topIds, expectedIds).toFixed(2)} MRR=${m.toFixed(2)} | ${tc.query}`
      );
    });
  }

  it('overall metrics summary', () => {
    let totalP3 = 0;
    let totalR3 = 0;
    let totalMRR = 0;
    const n = TEST_CASES.length;

    for (const tc of TEST_CASES) {
      const expectedIds = tc.expectedLabels.map((l) => seedIds[l]).filter(Boolean);
      const topIds = runQuery(tc.query);
      totalP3 += precision3(topIds, expectedIds);
      totalR3 += recall3(topIds, expectedIds);
      totalMRR += mrr(topIds, expectedIds);
    }

    const avgP3 = totalP3 / n;
    const avgR3 = totalR3 / n;
    const avgMRR = totalMRR / n;

    console.log('\n  ── Benchmark Summary ──────────────────────────────');
    console.log(`  Queries tested:  ${n}`);
    console.log(`  Avg Precision@3: ${avgP3.toFixed(3)}`);
    console.log(`  Avg Recall@3:    ${avgR3.toFixed(3)}`);
    console.log(`  Avg MRR:         ${avgMRR.toFixed(3)}`);
    console.log('  ───────────────────────────────────────────────────');

    // Hard floor: MRR should be > 0.3 (correct result usually in top-3)
    expect(avgMRR, `Avg MRR too low: ${avgMRR.toFixed(3)}`).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// Mechanical behaviour tests
// ---------------------------------------------------------------------------

describe('Decay mechanics', () => {
  it('strength drops below 0.25 after 14 days without retrieval (default half-life=7d)', () => {
    initStore(tmpDir); // already init, no-op if exists
    const entry = createMemory('temporary note');
    const fourteenDaysAgo = daysAgo(14);
    const aged: MemoryEntry = { ...entry, last_retrieved: fourteenDaysAgo };

    const s = calculateStrength(aged, new Date());
    // At 14 days = 2 half-lives: decay = 0.5^2 = 0.25; retrieval_boost=1; emotional=1.0 -> s ≈ 0.25
    expect(s).toBeLessThanOrEqual(0.25);
  });

  it('error-tagged memory stays stronger than neutral after 7 days', () => {
    const now = new Date();
    const sevenDaysAgo = daysAgo(7);

    const errorMem = createMemory('cache failure lesson', { tags: ['error'] });
    const neutralMem = createMemory('cache failure lesson', { tags: [] });

    const agedError: MemoryEntry = { ...errorMem, last_retrieved: sevenDaysAgo };
    const agedNeutral: MemoryEntry = { ...neutralMem, last_retrieved: sevenDaysAgo };

    const sError = calculateStrength(agedError, now);
    const sNeutral = calculateStrength(agedNeutral, now);

    // Error gets: longer half_life + negative emotional_multiplier (1.5x)
    expect(sError).toBeGreaterThan(sNeutral);
  });
});

describe('Retrieval strengthening', () => {
  it('recalled memory has higher half_life and strength than an unrecalled peer', () => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    let recalled = createMemory('recalled memory about deployment');
    // Write to store so markRetrieved can use
    recalled = { ...recalled, last_retrieved: sevenDaysAgo.toISOString() };
    const originalHalfLife = recalled.half_life_days;

    // Simulate 5 retrievals
    const retrieved = markRetrieved(
      markRetrieved(
        markRetrieved(
          markRetrieved(
            markRetrieved([recalled], now),
            now
          ),
          now
        ),
        now
      ),
      now
    );
    const finalEntry = retrieved[0];

    // 5 retrievals = +2 days each = +10 days to half_life
    expect(finalEntry.half_life_days).toBe(originalHalfLife + 10);

    // Compare strength against a same-age unrecalled peer
    const unrecalled: MemoryEntry = {
      ...recalled,
      retrieval_count: 0,
      half_life_days: originalHalfLife,
    };
    expect(calculateStrength(finalEntry, now)).toBeGreaterThan(calculateStrength(unrecalled, now));
  });
});

describe('Error priority', () => {
  it('error-tagged memory has 2x the half_life of identical neutral memory', () => {
    const errorMem = createMemory('same content here', { tags: ['error'] });
    const neutralMem = createMemory('same content here', { tags: [] });
    // error tag -> half_life * 2
    expect(errorMem.half_life_days).toBe(neutralMem.half_life_days * 2);
  });

  it('after 7 days, error-tagged strength > neutral strength', () => {
    const sevenDaysAgo = daysAgo(7);
    const now = new Date();

    const errorMem = createMemory('rule violation', { tags: ['error'] });
    const neutralMem = createMemory('rule violation', { tags: [] });

    const agedE: MemoryEntry = { ...errorMem, last_retrieved: sevenDaysAgo };
    const agedN: MemoryEntry = { ...neutralMem, last_retrieved: sevenDaysAgo };

    // error: half_life=14d, multiplier=1.5 -> decay=0.5^(7/14)=0.707, s=0.707*1.5=1.06 -> clamped to 1
    // neutral: half_life=7d, multiplier=1.0 -> decay=0.5^(7/7)=0.5, s=0.5
    expect(calculateStrength(agedE, now)).toBeGreaterThanOrEqual(
      2 * calculateStrength(agedN, now)
    );
  });
});

describe('Outcome feedback', () => {
  it('--good increments outcome_positive counter', () => {
    const entry = createMemory('some lesson');
    const updated = applyOutcome(entry, true);
    expect(updated.outcome_positive).toBe(1);
    expect(updated.outcome_negative).toBe(0);
    expect(updated.outcome_score).toBe(1);
    expect(updated.half_life_days).toBe(entry.half_life_days);
  });

  it('--bad increments outcome_negative counter', () => {
    const entry = createMemory('some lesson');
    const updated = applyOutcome(entry, false);
    expect(updated.outcome_positive).toBe(0);
    expect(updated.outcome_negative).toBe(1);
    expect(updated.outcome_score).toBe(-1);
    expect(updated.half_life_days).toBe(entry.half_life_days);
  });
});

describe('Token budget', () => {
  it('total returned tokens respect budget of 100', () => {
    const entries = loadAllEntries(tmpDir);
    const results = search('production deployment rules', entries, { budget: 100 });

    const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(100);
  });

  it('returns at least some results even with tight budget', () => {
    // With budget=50 we should still get at least 1 result (short memories)
    const shortEntry = createMemory('Use ; not && in PowerShell.');
    writeEntry(tmpDir, shortEntry);

    const entries = loadAllEntries(tmpDir);
    const results = search('PowerShell', entries, { budget: 50 });
    // The first result is always included even if it exceeds budget
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Second and beyond should not push total far past budget
    if (results.length > 1) {
      const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
      expect(totalTokens).toBeLessThanOrEqual(100); // generous cap for first-result override
    }
  });
});
