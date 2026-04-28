/**
 * Self-contained feature evaluation suite for hippo.
 *
 * Creates a synthetic memory corpus with known ground truth, runs searches
 * per feature category, and reports per-feature metrics with regression
 * detection against a saved baseline.
 *
 * Design goals:
 *  - Zero API calls (no LLM judge, no embeddings)
 *  - Deterministic (fixed timestamps, content, IDs)
 *  - Fast (<60s for full suite)
 *  - Per-feature breakdown so you see exactly what a change helped/hurt
 */

import { createMemory, Layer, type MemoryEntry } from './memory.js';
import { search, hybridSearch, detectTemporalDirection, computeTemporalRange, temporalBoost } from './search.js';
import { multihopSearch } from './multihop.js';
import { mrr, recallAtK, ndcgAtK } from './eval.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeatureCategory =
  | 'direct-recall'
  | 'extraction-preference'
  | 'dag-drilldown'
  | 'temporal'
  | 'noise-resistance'
  | 'multi-hop';

export interface FeatureTestCase {
  id: string;
  category: FeatureCategory;
  query: string;
  expectedIds: string[];
  description: string;
}

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

// ---------------------------------------------------------------------------
// Synthetic corpus — deterministic, no API calls
// ---------------------------------------------------------------------------

const BASE_DATE = new Date('2026-01-15T10:00:00Z');

function dateOffset(days: number): string {
  const d = new Date(BASE_DATE.getTime() + days * 86400000);
  return d.toISOString();
}

function mem(id: string, content: string, opts: {
  layer?: Layer; tags?: string[]; created?: string;
  extracted_from?: string; dag_level?: number; dag_parent_id?: string;
} = {}): MemoryEntry {
  const entry = createMemory(content, {
    layer: opts.layer ?? Layer.Episodic,
    tags: opts.tags ?? [],
    baseHalfLifeDays: 30,
    extracted_from: opts.extracted_from,
    dag_level: opts.dag_level,
    dag_parent_id: opts.dag_parent_id,
  });
  (entry as any).id = id;
  if (opts.created) (entry as any).created = opts.created;
  return entry;
}

export function buildSyntheticCorpus(): { entries: MemoryEntry[]; cases: FeatureTestCase[] } {
  const entries: MemoryEntry[] = [];
  const cases: FeatureTestCase[] = [];

  // =========================================================================
  // 1. DIRECT RECALL — basic keyword matching
  // =========================================================================

  entries.push(
    mem('dr-1', 'The PostgreSQL database migration failed because the users table had a NOT NULL constraint on the email column', { created: dateOffset(1), tags: ['topic:database'] }),
    mem('dr-2', 'React component rendering performance improved by 40% after memoizing the expensive computation in useMemo', { created: dateOffset(2), tags: ['topic:frontend'] }),
    mem('dr-3', 'The API rate limiter should use a sliding window algorithm instead of fixed window to prevent burst traffic', { created: dateOffset(3), tags: ['topic:api'] }),
    mem('dr-4', 'Docker container memory limits need to be set to 512MB for the worker service to prevent OOM kills', { created: dateOffset(4), tags: ['topic:devops'] }),
    mem('dr-5', 'The JWT token expiration was set to 24 hours but should be reduced to 1 hour for security compliance', { created: dateOffset(5), tags: ['topic:security'] }),
    mem('dr-6', 'Webpack bundle size grew to 2.3MB because lodash was imported as a whole instead of cherry-picking', { created: dateOffset(6), tags: ['topic:frontend'] }),
    mem('dr-7', 'The Redis cache TTL for user sessions should match the JWT expiration to prevent stale sessions', { created: dateOffset(7), tags: ['topic:caching'] }),
    mem('dr-8', 'GraphQL resolver for nested comments has N+1 query problem solved by DataLoader batching', { created: dateOffset(8), tags: ['topic:api'] }),
  );

  cases.push(
    { id: 'dr-q1', category: 'direct-recall', query: 'PostgreSQL migration NOT NULL constraint', expectedIds: ['dr-1'], description: 'exact keyword match on DB migration' },
    { id: 'dr-q2', category: 'direct-recall', query: 'React useMemo performance memoizing', expectedIds: ['dr-2'], description: 'React performance optimization' },
    { id: 'dr-q3', category: 'direct-recall', query: 'sliding window rate limiter API', expectedIds: ['dr-3'], description: 'API rate limiting approach' },
    { id: 'dr-q4', category: 'direct-recall', query: 'Docker OOM memory limits worker', expectedIds: ['dr-4'], description: 'Docker memory config' },
    { id: 'dr-q5', category: 'direct-recall', query: 'JWT token expiration security', expectedIds: ['dr-5'], description: 'JWT security setting' },
    { id: 'dr-q6', category: 'direct-recall', query: 'webpack bundle size lodash', expectedIds: ['dr-6'], description: 'bundle size issue' },
    { id: 'dr-q7', category: 'direct-recall', query: 'Redis cache TTL session expiration', expectedIds: ['dr-7'], description: 'cache TTL config' },
    { id: 'dr-q8', category: 'direct-recall', query: 'GraphQL N+1 DataLoader batching', expectedIds: ['dr-8'], description: 'GraphQL N+1 fix' },
  );

  // =========================================================================
  // 2. EXTRACTION PREFERENCE — extracted facts should rank above raw source
  // =========================================================================

  entries.push(
    mem('ep-src-1', 'speaker:Alice: So we had this big meeting yesterday about the deployment pipeline and Bob mentioned that the staging environment is using Kubernetes 1.28 and we should upgrade to 1.30 before the end of Q2 because of the security patches', {
      created: dateOffset(10), tags: ['speaker:Alice', 'topic:infrastructure', 'session:meeting-1'],
    }),
    mem('ep-ext-1', 'The staging environment runs Kubernetes 1.28 and needs to be upgraded to 1.30 before end of Q2 for security patches', {
      created: dateOffset(10), layer: Layer.Semantic, tags: ['speaker:Alice', 'topic:infrastructure', 'extracted'],
      extracted_from: 'ep-src-1',
    }),
    mem('ep-src-2', 'speaker:Bob: Yeah and the thing about the monitoring is that we switched from Datadog to Grafana last month and the alerting rules still need to be migrated, Carol was supposed to handle that but she has been busy with the frontend rewrite', {
      created: dateOffset(11), tags: ['speaker:Bob', 'topic:monitoring', 'session:meeting-1'],
    }),
    mem('ep-ext-2', 'The team switched from Datadog to Grafana last month but alerting rules have not been migrated yet. Carol is responsible but blocked by the frontend rewrite.', {
      created: dateOffset(11), layer: Layer.Semantic, tags: ['speaker:Bob', 'topic:monitoring', 'extracted'],
      extracted_from: 'ep-src-2',
    }),
    mem('ep-src-3', 'speaker:Carol: The login page redesign is almost done, I just need to wire up the OAuth2 PKCE flow with the new identity provider and write the integration tests', {
      created: dateOffset(12), tags: ['speaker:Carol', 'topic:auth', 'session:meeting-2'],
    }),
    mem('ep-ext-3', 'Carol is nearly done with the login page redesign. Remaining work: wire up OAuth2 PKCE flow with the new identity provider and write integration tests.', {
      created: dateOffset(12), layer: Layer.Semantic, tags: ['speaker:Carol', 'topic:auth', 'extracted'],
      extracted_from: 'ep-src-3',
    }),
  );

  cases.push(
    { id: 'ep-q1', category: 'extraction-preference', query: 'Kubernetes upgrade staging environment', expectedIds: ['ep-ext-1'], description: 'extracted fact about K8s upgrade should rank above raw utterance' },
    { id: 'ep-q2', category: 'extraction-preference', query: 'Datadog Grafana alerting migration', expectedIds: ['ep-ext-2'], description: 'extracted fact about monitoring switch' },
    { id: 'ep-q3', category: 'extraction-preference', query: 'OAuth2 PKCE login page redesign', expectedIds: ['ep-ext-3'], description: 'extracted fact about auth work' },
  );

  // =========================================================================
  // 3. DAG DRILL-DOWN — summary nodes should surface children
  // =========================================================================

  entries.push(
    mem('dag-child-1', 'The API response time for /users endpoint degraded from 50ms to 300ms after adding the permissions check', {
      created: dateOffset(15), layer: Layer.Semantic, tags: ['topic:api-performance', 'extracted'],
      dag_level: 1,
    }),
    mem('dag-child-2', 'The /orders endpoint latency spiked to 500ms because of a missing index on the orders.created_at column', {
      created: dateOffset(15), layer: Layer.Semantic, tags: ['topic:api-performance', 'extracted'],
      dag_level: 1,
    }),
    mem('dag-child-3', 'Batch API endpoint /reports/generate takes 8 seconds because it runs synchronously instead of using a job queue', {
      created: dateOffset(15), layer: Layer.Semantic, tags: ['topic:api-performance', 'extracted'],
      dag_level: 1,
    }),
    mem('dag-summary-1', 'API performance issues: /users degraded to 300ms (permissions check), /orders spiked to 500ms (missing index), /reports takes 8s (needs job queue)', {
      created: dateOffset(16), layer: Layer.Semantic, tags: ['topic:api-performance'],
      dag_level: 2, dag_parent_id: undefined,
    }),
  );
  // Link children to parent
  for (const child of [entries.find(e => e.id === 'dag-child-1')!, entries.find(e => e.id === 'dag-child-2')!, entries.find(e => e.id === 'dag-child-3')!]) {
    (child as any).dag_parent_id = 'dag-summary-1';
  }

  cases.push(
    { id: 'dag-q1', category: 'dag-drilldown', query: 'API performance problems latency', expectedIds: ['dag-child-1', 'dag-child-2', 'dag-child-3', 'dag-summary-1'], description: 'summary should drill down to all children' },
    { id: 'dag-q2', category: 'dag-drilldown', query: 'endpoint response time degradation', expectedIds: ['dag-child-1', 'dag-child-2', 'dag-summary-1'], description: 'query matching summary should surface relevant children' },
  );

  // =========================================================================
  // 4. TEMPORAL — recency/oldest cues should affect ranking
  // =========================================================================

  entries.push(
    mem('tmp-1', 'The team decided to use TypeScript for the new service', { created: dateOffset(-30), tags: ['topic:architecture'] }),
    mem('tmp-2', 'The team evaluated Rust as an alternative language for the service', { created: dateOffset(-20), tags: ['topic:architecture'] }),
    mem('tmp-3', 'The team added Go as a candidate language for the service rewrite', { created: dateOffset(-10), tags: ['topic:architecture'] }),
    mem('tmp-4', 'The team finalized the language choice as Go for the service rewrite', { created: dateOffset(-1), tags: ['topic:architecture'] }),
  );

  cases.push(
    { id: 'tmp-q1', category: 'temporal', query: 'what did the team recently decide about the service language', expectedIds: ['tmp-4'], description: 'recent cue should boost newest entry' },
    { id: 'tmp-q2', category: 'temporal', query: 'what was the first language choice for the service', expectedIds: ['tmp-1'], description: 'oldest cue should boost earliest entry' },
    { id: 'tmp-q3', category: 'temporal', query: 'latest update on the service rewrite language', expectedIds: ['tmp-4'], description: 'latest should boost most recent' },
    { id: 'tmp-q4', category: 'temporal', query: 'original architecture decision for the service', expectedIds: ['tmp-1'], description: 'original should boost earliest' },
  );

  // =========================================================================
  // 5. NOISE RESISTANCE — relevant memories found despite noise
  // =========================================================================

  // Add 30 noise entries
  const noiseTopics = [
    'breakfast meeting catering ordered sandwiches', 'office temperature thermostat adjusted',
    'printer paper refill third floor supply', 'parking lot gate code changed 4521',
    'fire drill scheduled next Thursday morning', 'coffee machine broken maintenance called',
    'desk booking system new policy hybrid', 'meeting room projector HDMI adapter missing',
    'birthday celebration for Dave next Friday', 'recycling bins moved to kitchen area',
    'badge access updated for new hires', 'elevator maintenance scheduled weekend',
    'lunch order from Italian place confirmed', 'desk plants watering schedule posted',
    'air conditioning unit serviced last week', 'office carpet cleaning Friday evening',
    'new microwave installed in kitchen', 'visitor parking available spots three',
    'holiday schedule posted on intranet', 'team photo session Thursday afternoon',
    'chair ergonomics assessment signup sheet', 'standing desk adjustment instructions',
    'kitchen fridge cleanup policy reminder', 'window blinds replaced on south side',
    'bicycle rack installed in parking garage', 'team lunch budget increased quarterly',
    'noise canceling headphones approved expense', 'monitor arm request form updated',
    'desk drawer key replacement procedure', 'building security hours extended',
  ];
  for (let i = 0; i < noiseTopics.length; i++) {
    entries.push(mem(`noise-${i}`, noiseTopics[i], { created: dateOffset(i), tags: ['topic:office'] }));
  }

  entries.push(
    mem('nr-1', 'The database connection pool was exhausted because max_connections was set to 10 but the application had 25 concurrent requests', {
      created: dateOffset(20), tags: ['topic:database', 'topic:performance'],
    }),
    mem('nr-2', 'The S3 bucket policy was misconfigured allowing public read access to customer data uploads', {
      created: dateOffset(21), tags: ['topic:security', 'topic:s3'],
    }),
  );

  cases.push(
    { id: 'nr-q1', category: 'noise-resistance', query: 'database connection pool exhausted max connections', expectedIds: ['nr-1'], description: 'find DB issue despite 30 noise entries' },
    { id: 'nr-q2', category: 'noise-resistance', query: 'S3 bucket public access security misconfiguration', expectedIds: ['nr-2'], description: 'find S3 issue despite noise' },
    { id: 'nr-q3', category: 'noise-resistance', query: 'PostgreSQL migration constraint', expectedIds: ['dr-1'], description: 'find earlier DB entry despite noise' },
    { id: 'nr-q4', category: 'noise-resistance', query: 'JWT token security expiration', expectedIds: ['dr-5'], description: 'find security entry despite noise' },
  );

  // =========================================================================
  // 6. MULTI-HOP — entity chaining across sessions
  // =========================================================================

  entries.push(
    mem('mh-1', 'speaker:Alice works on the payment gateway integration with Stripe. She found a webhook signature validation bug.', {
      created: dateOffset(25), tags: ['speaker:Alice', 'topic:payments'],
    }),
    mem('mh-2', 'speaker:Bob reviewed the Stripe webhook code and confirmed the signature validation uses the wrong secret key from the test environment.', {
      created: dateOffset(26), tags: ['speaker:Bob', 'topic:payments'],
    }),
    mem('mh-3', 'speaker:Alice fixed the Stripe webhook by switching to the production secret key. Payment confirmations now arrive within 2 seconds.', {
      created: dateOffset(27), tags: ['speaker:Alice', 'topic:payments'],
    }),
    mem('mh-4', 'speaker:Carol reported that the billing dashboard shows incorrect revenue numbers because it reads from the payments_raw table instead of payments_reconciled.', {
      created: dateOffset(28), tags: ['speaker:Carol', 'topic:billing'],
    }),
  );

  cases.push(
    { id: 'mh-q1', category: 'multi-hop', query: 'Who fixed the Stripe webhook bug and what was the root cause?', expectedIds: ['mh-1', 'mh-2', 'mh-3'], description: 'chain Alice -> Stripe -> Bob -> fix' },
    { id: 'mh-q2', category: 'multi-hop', query: 'What are all the payment-related issues the team discussed?', expectedIds: ['mh-1', 'mh-2', 'mh-3', 'mh-4'], description: 'find all payment topics across speakers' },
  );

  return { entries, cases };
}

// ---------------------------------------------------------------------------
// Runner — evaluates each case against the synthetic corpus
// ---------------------------------------------------------------------------

export async function runFeatureEval(version: string): Promise<EvalSuiteResult> {
  const start = Date.now();
  const { entries, cases } = buildSyntheticCorpus();

  const caseResults: Array<{ case: FeatureTestCase; returnedIds: string[]; mrrVal: number; r5: number; ndcg5: number }> = [];

  for (const c of cases) {
    let results;
    if (c.category === 'multi-hop') {
      results = multihopSearch(c.query, entries, { budget: 50000 });
    } else {
      results = search(c.query, entries, { budget: 50000 });
    }
    const returnedIds = results.map(r => r.entry.id);

    caseResults.push({
      case: c,
      returnedIds,
      mrrVal: mrr(returnedIds, c.expectedIds),
      r5: recallAtK(returnedIds, c.expectedIds, 5),
      ndcg5: ndcgAtK(returnedIds, c.expectedIds, 5),
    });
  }

  const categories = [...new Set(cases.map(c => c.category))] as FeatureCategory[];
  const features: FeatureResult[] = categories.map(cat => {
    const catCases = caseResults.filter(r => r.case.category === cat);
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

  const totalCases = caseResults.length;
  const overallMrr = caseResults.reduce((s, r) => s + r.mrrVal, 0) / totalCases;
  const overallR5 = caseResults.reduce((s, r) => s + r.r5, 0) / totalCases;
  const overallNdcg5 = caseResults.reduce((s, r) => s + r.ndcg5, 0) / totalCases;

  return {
    version,
    timestamp: new Date().toISOString(),
    features,
    overall: { mrr: overallMrr, recallAt5: overallR5, ndcgAt5: overallNdcg5 },
    totalCases,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Regression detection
// ---------------------------------------------------------------------------

const REGRESSION_THRESHOLD = 0.05;

export function detectRegressions(baseline: EvalBaseline, current: EvalSuiteResult): RegressionReport {
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
        regressions.push({ category: feat.category, metric, baseline: baseVal, current: curVal, delta });
      } else if (delta > REGRESSION_THRESHOLD) {
        improvements.push({ category: feat.category, metric, baseline: baseVal, current: curVal, delta });
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
  const features: EvalBaseline['features'] = {} as any;
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

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

function pad(s: string, w: number): string {
  return s.padEnd(w);
}

function deltaStr(d: number): string {
  const sign = d >= 0 ? '+' : '';
  return sign + pct(d);
}

export function formatResult(result: EvalSuiteResult, baseline?: EvalBaseline): string {
  const lines: string[] = [];
  lines.push(`Hippo Eval v${result.version} — ${result.totalCases} queries, ${result.durationMs}ms`);
  lines.push('');
  lines.push(`${pad('Feature', 24)} | ${pad('MRR', 8)} | ${pad('R@5', 8)} | ${pad('NDCG@5', 8)} | ${pad('vs baseline', 12)} | verdict`);
  lines.push(`${'─'.repeat(24)}-|-${'─'.repeat(8)}-|-${'─'.repeat(8)}-|-${'─'.repeat(8)}-|-${'─'.repeat(12)}-|${'─'.repeat(8)}`);

  let report: RegressionReport | undefined;
  if (baseline) {
    report = detectRegressions(baseline, result);
  }

  for (const feat of result.features) {
    const base = baseline?.features[feat.category];
    let vsBaseline = 'NEW';
    let verdict = 'baseline';
    if (base) {
      const delta = feat.ndcgAt5 - base.ndcgAt5;
      vsBaseline = deltaStr(delta);
      verdict = delta < -REGRESSION_THRESHOLD ? 'REGRESS' : 'PASS';
    }
    lines.push(
      `${pad(feat.category, 24)} | ${pad(pct(feat.mrr), 8)} | ${pad(pct(feat.recallAt5), 8)} | ${pad(pct(feat.ndcgAt5), 8)} | ${pad(vsBaseline, 12)} | ${verdict}`
    );
  }

  lines.push('');
  lines.push(`Overall: MRR ${pct(result.overall.mrr)} | R@5 ${pct(result.overall.recallAt5)} | NDCG@5 ${pct(result.overall.ndcgAt5)}`);

  if (report) {
    if (report.verdict === 'REGRESSION') {
      lines.push('');
      lines.push(`REGRESSIONS DETECTED (>${pct(REGRESSION_THRESHOLD)} drop):`);
      for (const r of report.regressions) {
        lines.push(`  ${r.category}.${r.metric}: ${pct(r.baseline)} -> ${pct(r.current)} (${deltaStr(r.delta)})`);
      }
    }
    if (report.improvements.length > 0) {
      lines.push('');
      lines.push('Improvements:');
      for (const imp of report.improvements) {
        lines.push(`  ${imp.category}.${imp.metric}: ${pct(imp.baseline)} -> ${pct(imp.current)} (${deltaStr(imp.delta)})`);
      }
    }
    lines.push('');
    lines.push(`Verdict: ${report.verdict}${report.regressions.length > 0 ? ` (${report.regressions.length} regressions)` : ''}`);
  }

  return lines.join('\n');
}
