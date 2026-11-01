/**
 * The feature eval runner, regression detection and report. Zero API calls (no LLM judge, no
 * embeddings), deterministic and fast; the corpus it scores is built in eval-suite-corpus.ts. */

import { rankBm25 } from '../search/bm25-search.js';
import type { EvalSwitches } from '../../base/memory/eval-switches.js';
import { rankMultihop } from '../search/multihop.js';
import { mrr, recallAtK, ndcgAtK } from './eval.js';
import {
  buildSyntheticCorpus,
  type FeatureCategory,
  type FeatureTestCase,
} from './eval-suite-corpus.js';
import { pct } from '../../base/util/format.js';

export interface FeatureResult {
  category: FeatureCategory;
  cases: number;
  mrr: number;
  recallAt5: number;
  ndcgAt5: number;
  passed: boolean;
}

export interface EvalSuiteResult {
  version: string;
  timestamp: string;
  features: FeatureResult[];
  overall: { mrr: number; recallAt5: number; ndcgAt5: number };
  totalCases: number;
  durationMs: number;
}

export interface EvalBaseline {
  version: string;
  timestamp: string;
  features: Record<FeatureCategory, { mrr: number; recallAt5: number; ndcgAt5: number }>;
  overall: { mrr: number; recallAt5: number; ndcgAt5: number };
}

export interface RegressionReport {
  regressions: Array<{
    category: FeatureCategory;
    metric: string;
    baseline: number;
    current: number;
    delta: number;
  }>;
  improvements: Array<{
    category: FeatureCategory;
    metric: string;
    baseline: number;
    current: number;
    delta: number;
  }>;
  verdict: 'PASS' | 'REGRESSION';
}

interface ScoredFeatureCase {
  case: FeatureTestCase;
  returnedIds: string[];
  mrrVal: number;
  r5: number;
  ndcg5: number;
}

/** Each category's mean scores, in the order the corpus first names the category. */
function featureAverages(
  cases: readonly FeatureTestCase[],
  caseResults: readonly ScoredFeatureCase[],
): FeatureResult[] {
  const categories = [...new Set(cases.map((c) => c.category))];
  return categories.map((cat) => {
    const catCases = caseResults.filter((r) => r.case.category === cat);
    const n = catCases.length;
    const avgMrr = catCases.reduce((s, r) => s + r.mrrVal, 0) / n;
    const avgR5 = catCases.reduce((s, r) => s + r.r5, 0) / n;
    const avgNdcg5 = catCases.reduce((s, r) => s + r.ndcg5, 0) / n;
    return {
      category: cat,
      cases: n,
      mrr: avgMrr,
      recallAt5: avgR5,
      ndcgAt5: avgNdcg5,
      passed: true,
    };
  });
}

/** Ranks the synthetic corpus under `switches`, built and scored at `now`. */
export async function runFeatureEval(
  version: string,
  switches: EvalSwitches,
  now: Date,
): Promise<EvalSuiteResult> {
  const start = Date.now();
  const { entries, cases } = buildSyntheticCorpus(now);

  const caseResults: ScoredFeatureCase[] = [];

  for (const c of cases) {
    let results;
    if (c.category === 'multi-hop') {
      results = rankMultihop(c.query, entries, { budget: EVAL_TOKEN_BUDGET, switches, now });
    } else {
      results = rankBm25(c.query, entries, { budget: EVAL_TOKEN_BUDGET, switches, now });
    }
    const returnedIds = results.map((r) => r.entry.id);

    caseResults.push({
      case: c,
      returnedIds,
      mrrVal: mrr(returnedIds, c.expectedIds),
      r5: recallAtK(returnedIds, c.expectedIds, 5),
      ndcg5: ndcgAtK(returnedIds, c.expectedIds, 5),
    });
  }

  const features = featureAverages(cases, caseResults);

  const totalCases = caseResults.length;
  const overallMrr = caseResults.reduce((s, r) => s + r.mrrVal, 0) / totalCases;
  const overallR5 = caseResults.reduce((s, r) => s + r.r5, 0) / totalCases;
  const overallNdcg5 = caseResults.reduce((s, r) => s + r.ndcg5, 0) / totalCases;

  return {
    version,
    timestamp: now.toISOString(),
    features,
    overall: { mrr: overallMrr, recallAt5: overallR5, ndcgAt5: overallNdcg5 },
    totalCases,
    durationMs: Date.now() - start,
  };
}

const REGRESSION_THRESHOLD = 0.05;
// Large enough that the token budget never cuts a synthetic case's results, so the metrics see the
// whole ranking.
const EVAL_TOKEN_BUDGET = 50000;

export function detectRegressions(
  baseline: EvalBaseline,
  current: EvalSuiteResult,
): RegressionReport {
  const regressions: RegressionReport['regressions'] = [];
  const improvements: RegressionReport['improvements'] = [];

  for (const feat of current.features) {
    const base = baseline.features[feat.category];
    if (!base) continue;

    for (const metric of ['mrr', 'recallAt5', 'ndcgAt5'] as const) {
      const baseVal = base[metric];
      const curVal = feat[metric];
      const delta = curVal - baseVal;

      if (delta < -REGRESSION_THRESHOLD) {
        regressions.push({
          category: feat.category,
          metric,
          baseline: baseVal,
          current: curVal,
          delta,
        });
      } else if (delta > REGRESSION_THRESHOLD) {
        improvements.push({
          category: feat.category,
          metric,
          baseline: baseVal,
          current: curVal,
          delta,
        });
      }
    }
  }

  return {
    regressions,
    improvements,
    verdict: regressions.length > 0 ? 'REGRESSION' : 'PASS',
  };
}

export function resultToBaseline(result: EvalSuiteResult): EvalBaseline {
  // SAFETY: the loop below sets every FeatureCategory key from result.features, which holds every
  // category in buildSyntheticCorpus's cases.
  const features: EvalBaseline['features'] = {} as EvalBaseline['features'];
  for (const f of result.features) {
    features[f.category] = { mrr: f.mrr, recallAt5: f.recallAt5, ndcgAt5: f.ndcgAt5 };
  }
  return {
    version: result.version,
    timestamp: result.timestamp,
    features,
    overall: result.overall,
  };
}

function pad(s: string, w: number): string {
  return s.padEnd(w);
}

function deltaStr(d: number): string {
  const sign = d >= 0 ? '+' : '';
  return sign + pct(d);
}

function formatFeatureRow(feat: FeatureResult, base: { ndcgAt5: number } | undefined): string {
  let vsBaseline = 'NEW';
  let verdict = 'baseline';
  if (base) {
    const delta = feat.ndcgAt5 - base.ndcgAt5;
    vsBaseline = deltaStr(delta);
    verdict = delta < -REGRESSION_THRESHOLD ? 'REGRESS' : 'PASS';
  }
  const cells = [
    pad(feat.category, 24),
    pad(pct(feat.mrr), 8),
    pad(pct(feat.recallAt5), 8),
    pad(pct(feat.ndcgAt5), 8),
    pad(vsBaseline, 12),
    verdict,
  ];
  return cells.join(' | ');
}

function formatReportLines(report: RegressionReport): string[] {
  const lines: string[] = [];
  if (report.verdict === 'REGRESSION') {
    lines.push('');
    lines.push(`REGRESSIONS DETECTED (>${pct(REGRESSION_THRESHOLD)} drop):`);
    for (const r of report.regressions) {
      lines.push(
        `  ${r.category}.${r.metric}: ${pct(r.baseline)} -> ${pct(r.current)} (${deltaStr(r.delta)})`,
      );
    }
  }
  if (report.improvements.length > 0) {
    lines.push('');
    lines.push('Improvements:');
    for (const imp of report.improvements) {
      lines.push(
        `  ${imp.category}.${imp.metric}: ${pct(imp.baseline)} -> ${pct(imp.current)} (${deltaStr(imp.delta)})`,
      );
    }
  }
  lines.push('');
  lines.push(
    `Verdict: ${report.verdict}${report.regressions.length > 0 ? ` (${report.regressions.length} regressions)` : ''}`,
  );
  return lines;
}

export function formatResult(result: EvalSuiteResult, baseline?: EvalBaseline): string {
  const lines: string[] = [];
  lines.push(
    `Hippo Eval v${result.version} — ${result.totalCases} queries, ${result.durationMs}ms`,
  );
  lines.push('');
  lines.push(
    `${pad('Feature', 24)} | ${pad('MRR', 8)} | ${pad('R@5', 8)} | ${pad('NDCG@5', 8)} | ${pad('vs baseline', 12)} | ` +
      `verdict`,
  );
  lines.push(
    `${'─'.repeat(24)}-|-${'─'.repeat(8)}-|-${'─'.repeat(8)}-|-` +
      `${'─'.repeat(8)}-|-${'─'.repeat(12)}-|${'─'.repeat(8)}`,
  );

  let report: RegressionReport | undefined;
  if (baseline) {
    report = detectRegressions(baseline, result);
  }

  for (const feat of result.features) {
    lines.push(formatFeatureRow(feat, baseline?.features[feat.category]));
  }

  lines.push('');
  lines.push(
    `Overall: MRR ${pct(result.overall.mrr)} | R@5 ${pct(result.overall.recallAt5)} | NDCG@5 ` +
      `${pct(result.overall.ndcgAt5)}`,
  );

  if (report) lines.push(...formatReportLines(report));

  return lines.join('\n');
}
