/**
 * Retrieval Quality Benchmark for Hippo.
 * Measures quality, not speed: the CI step "Perf regression gate" is the performance gate.
 *
 * Seeds 50+ real memories from MEMORY.md (lessons learned in production)
 * and validates that natural-language queries surface the right memories.
 *
 * Metrics per query:
 *   Precision@3 - of top-3 results, fraction that were expected
 *   Recall@3    - of expected IDs, fraction that appeared in top-3
 *   MRR         - 1/rank of first correct result (0 if none in top-10)
 */
import { describe, it, expect } from 'vitest';
import { search } from '../../src/domain/search/bm25-search.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { tmpDir, seedIds, useBenchmarkCorpus } from '../_helpers/benchmark-corpus.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

useBenchmarkCorpus();

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

interface QueryCase {
  query: string;
  expectedLabels: string[]; // seed labels that should appear in top-3
}

function runQuery(query: string, n = 10): string[] {
  const entries = loadAllEntries(tmpDir, 'default');
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
    const entries = loadAllEntries(tmpDir, 'default');
    // We seed >30 memories explicitly above
    expect(entries.length).toBeGreaterThanOrEqual(30);
  });

  // Run each query and assert MRR > 0 (at least one correct result in top-10)
  for (const tc of TEST_CASES) {
    it(`query: "${tc.query}"`, () => {
      const expectedIds = tc.expectedLabels.map((l) => seedIds[l]).filter(Boolean);
      expect(expectedIds).toHaveLength(tc.expectedLabels.length); // sanity check all labels exist

      const topIds = runQuery(tc.query);
      const m = mrr(topIds, expectedIds);
      const p3 = precision3(topIds, expectedIds);

      // Something relevant in the top-10: a hit at rank 10 scores 1/10, and the rank is the scorer's to choose.
      expect(m, `MRR=0 for query "${tc.query}". Top results: ${topIds.slice(0, 3).join(', ')}`).toBeGreaterThanOrEqual(
        0.1,
      );

      // Log for visibility (doesn't fail)
      console.log(
        `  P@3=${p3.toFixed(2)} Recall@3=${recall3(topIds, expectedIds).toFixed(2)} MRR=${m.toFixed(2)} | ${tc.query}`,
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
