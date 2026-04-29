/**
 * p99 recall benchmark — A1 ROADMAP success criterion.
 *
 * Pinned spec:
 *   - Query mix: top-10 BM25 against tier-1 micro-eval queries
 *   - Cold cache (fresh server start, no warmup)
 *   - Single SQLite connection (server default)
 *   - Store: 10k synthetic memories with realistic distribution
 *   - Success: p99 < 50ms
 *
 * Note on "Hybrid embeddings ON" from the ROADMAP: src/api.ts:recall is
 * BM25-only today (the `mode` param is forward-compat). The HTTP recall
 * surface measured here is the actual implementation. When hybrid lands
 * (post-A1), re-run with the same harness.
 *
 * Last measured (v0.36.0 candidate, 10k / 1000 queries):
 *   p50 = 39.5ms  p95 = 54.9ms  p99 = 58.4ms  mean = 41.0ms
 *   gate: FAIL — 58.4ms vs 50ms target. Tracked in TODOS.md under
 *   "v0.37.0 — A1 p99 latency hardening". Architecture ships; the
 *   latency target slips one minor.
 *
 * Run:
 *   node --experimental-strip-types benchmarks/a1/p99-recall.ts \
 *     --store-size 10000 --queries 1000
 *
 * Or via vitest harness (downsized) — see tests/server-p99.test.ts.
 *
 * Output JSON lands in benchmarks/a1/results/p99-<timestamp>.json.
 * Exit code 0 if p99 < 50ms, else 1 (CI gate).
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Imports resolve against the compiled dist/ output. Run `npm run build` first,
// then `node --experimental-strip-types benchmarks/a1/p99-recall.ts`.
import { initStore } from '../../dist/store.js';
import { remember as apiRemember } from '../../dist/api.js';
import { serve, type ServerHandle } from '../../dist/server.js';

interface CliArgs {
  storeSize: number;
  queries: number;
  port: number;
}

interface Stats {
  count: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
}

interface Result {
  store_size: number;
  query_count: number;
  total_wall_ms: number;
  stats_ms: Stats;
  gate_pass: boolean;
  gate_threshold_ms: number;
  notes: string[];
  generated_at: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { storeSize: 10000, queries: 1000, port: 6789 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store-size') args.storeSize = Number(argv[++i]);
    else if (a === '--queries') args.queries = Number(argv[++i]);
    else if (a === '--port') args.port = Number(argv[++i]);
  }
  return args;
}

const TAG_CLUSTERS: ReadonlyArray<{ tag: string; words: ReadonlyArray<string> }> = [
  { tag: 'auth', words: ['auth', 'login', 'oauth', 'session', 'token', 'jwt', 'bearer', 'sso'] },
  { tag: 'database', words: ['database', 'postgres', 'mysql', 'sqlite', 'index', 'query', 'schema', 'migration'] },
  { tag: 'deploy', words: ['deployment', 'production', 'staging', 'rollout', 'kubernetes', 'docker', 'container'] },
  { tag: 'people', words: ['Bob', 'Alice', 'Carla', 'team', 'standup', 'manager', 'engineer'] },
  { tag: 'food', words: ['coffee', 'tea', 'latte', 'oat', 'milk', 'breakfast', 'lunch'] },
  { tag: 'api', words: ['API', 'rate', 'limit', 'endpoint', 'request', 'response', 'http', 'rest'] },
  { tag: 'python', words: ['Python', 'venv', 'pip', 'package', 'requirements', 'wheel'] },
  { tag: 'frontend', words: ['React', 'component', 'state', 'render', 'props', 'css'] },
  { tag: 'infra', words: ['server', 'load', 'balancer', 'nginx', 'caddy', 'certificate'] },
  { tag: 'docs', words: ['readme', 'docs', 'spec', 'changelog', 'todo', 'plan'] },
];

const FILLER_WORDS: ReadonlyArray<string> = [
  'the', 'a', 'is', 'on', 'in', 'at', 'for', 'with', 'about', 'reference',
  'note', 'context', 'detail', 'fact', 'value', 'config', 'setting', 'flag',
  'option', 'parameter', 'data', 'record', 'entry', 'item', 'thing',
];

/** Deterministic LCG so seedings are reproducible across runs. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(rng: () => number, arr: ReadonlyArray<T>): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function buildContent(rng: () => number, cluster: { tag: string; words: ReadonlyArray<string> }): string {
  const targetLen = 50 + Math.floor(rng() * 451); // 50–500 chars
  const parts: string[] = [];
  let len = 0;
  while (len < targetLen) {
    const word = rng() < 0.6 ? pick(rng, cluster.words) : pick(rng, FILLER_WORDS);
    parts.push(word);
    len += word.length + 1;
  }
  return parts.join(' ').slice(0, targetLen).trim();
}

function loadTier1Queries(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturesDir = resolve(here, '../micro/fixtures');
  const queries: string[] = [];
  try {
    for (const f of readdirSync(fixturesDir)) {
      if (!f.endsWith('.json')) continue;
      const data = JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')) as {
        queries?: Array<{ q?: string }>;
      };
      if (Array.isArray(data.queries)) {
        for (const q of data.queries) {
          if (typeof q.q === 'string' && q.q.length > 0) queries.push(q.q);
        }
      }
    }
  } catch {
    // fall through to fallback
  }
  if (queries.length === 0) {
    return [
      'auth migration',
      'oauth token',
      'production deployment',
      'database schema',
      'API rate limit',
      'Python deployment',
      'Bob coffee',
      'Alice tea',
      'standup time',
      'prod db',
      'login session',
      'kubernetes rollout',
      'react component',
      'nginx certificate',
      'changelog entry',
      'requirements wheel',
      'jwt bearer',
      'postgres index',
      'staging container',
      'team manager',
    ];
  }
  return queries;
}

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((acc, v) => acc + v, 0) / n;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  const pct = (p: number): number => sorted[Math.min(n - 1, Math.floor(p * n))]!;
  return {
    count: n,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    mean,
    stddev: Math.sqrt(variance),
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    p999: pct(0.999),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[p99-recall] storeSize=${args.storeSize} queries=${args.queries} port=${args.port}`);

  const home = mkdtempSync(join(tmpdir(), 'hippo-p99-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);

  // Seed phase. 90-day window of created timestamps is implicit in createMemory's
  // `now`; the bench uses content distribution, not temporal spread, since recall
  // ranks by BM25 + decay+strength but cold-cache p99 is dominated by FTS lookup.
  console.log(`[p99-recall] seeding ${args.storeSize} memories…`);
  const rng = makeRng(0xC0FFEE);
  const seedStart = Date.now();
  for (let i = 0; i < args.storeSize; i++) {
    const cluster = pick(rng, TAG_CLUSTERS);
    const content = buildContent(rng, cluster);
    apiRemember(
      { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' },
      { content, tags: [cluster.tag] },
    );
    if ((i + 1) % 1000 === 0) {
      console.log(`[p99-recall]   ${i + 1}/${args.storeSize} (${Date.now() - seedStart}ms)`);
    }
  }
  console.log(`[p99-recall] seed done in ${Date.now() - seedStart}ms`);

  const queries = loadTier1Queries();
  console.log(`[p99-recall] loaded ${queries.length} tier-1 queries`);

  // Server start AFTER seed so the bench measures cold-cache fetch latency
  // (no warmup query). Port 0 = ephemeral to avoid collisions.
  const server: ServerHandle = await serve({ hippoRoot: home, port: 0 });
  console.log(`[p99-recall] server listening on ${server.url}`);

  const samples: number[] = [];
  let errorCount = 0;
  const wallStart = Date.now();

  try {
    for (let i = 0; i < args.queries; i++) {
      const q = queries[i % queries.length]!;
      const url = `${server.url}/v1/memories?q=${encodeURIComponent(q)}&limit=10`;
      const t0 = performance.now();
      try {
        const res = await fetch(url);
        // Drain body — fetch latency includes full response read.
        await res.text();
        const dt = performance.now() - t0;
        if (!res.ok) {
          errorCount++;
        } else {
          samples.push(dt);
        }
      } catch (err) {
        errorCount++;
        if (errorCount <= 3) console.error(`[p99-recall] fetch error: ${(err as Error).message}`);
      }
    }
  } finally {
    await server.stop();
  }

  const wallMs = Date.now() - wallStart;

  const stats = computeStats(samples);
  const gateThreshold = 50;
  const gatePass = stats.p99 < gateThreshold;

  const notes: string[] = [];
  if (errorCount > 0) notes.push(`${errorCount} fetch errors (excluded from stats)`);
  notes.push('BM25 only — src/api.ts:recall does not yet wire hybrid embeddings');
  notes.push('Single SQLite connection (server default)');
  notes.push('Cold cache: no warmup query');

  const result: Result = {
    store_size: args.storeSize,
    query_count: samples.length,
    total_wall_ms: wallMs,
    stats_ms: stats,
    gate_pass: gatePass,
    gate_threshold_ms: gateThreshold,
    notes,
    generated_at: new Date().toISOString(),
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const resultsDir = resolve(here, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(resultsDir, `p99-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log('');
  console.log('━━━ p99 recall benchmark ━━━');
  console.log(`  store size:     ${args.storeSize}`);
  console.log(`  successful:     ${samples.length}/${args.queries}`);
  console.log(`  wall:           ${wallMs}ms`);
  console.log(`  min / mean:     ${stats.min.toFixed(2)} / ${stats.mean.toFixed(2)}ms`);
  console.log(`  p50 / p95:      ${stats.p50.toFixed(2)} / ${stats.p95.toFixed(2)}ms`);
  console.log(`  p99 / p999:     ${stats.p99.toFixed(2)} / ${stats.p999.toFixed(2)}ms`);
  console.log(`  max / stddev:   ${stats.max.toFixed(2)} / ${stats.stddev.toFixed(2)}ms`);
  console.log(`  gate (<${gateThreshold}ms): ${gatePass ? 'PASS' : 'FAIL'}`);
  console.log(`  output:         ${outPath}`);
  console.log('');

  rmSync(home, { recursive: true, force: true });
  process.exit(gatePass ? 0 : 1);
}

main().catch((err: Error) => {
  console.error('[p99-recall] fatal:', err);
  process.exit(2);
});
