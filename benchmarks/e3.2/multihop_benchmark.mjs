#!/usr/bin/env node
/**
 * E3.2 multi-hop graph recall benchmark (roadmap success criterion — DESCRIPTIVE, not a
 * ship gate). Measures whether `recall --hops 1` surfaces a supersession-linked
 * predecessor decision that the flat baseline (same `--include-superseded`, same budget)
 * ranks below the result cut because the predecessor's wording is lexically distinct
 * from the successor query.
 *
 * HONEST framing baked into the design (per the plan's grill fix):
 *  - On today's supersedes-only graph the predecessor is a SUPERSEDED memory, so it is
 *    only a candidate at all under --include-superseded; --hops then surfaces it via the
 *    graph edge regardless of lexical score. Cross-object edges (future E3.1) link ACTIVE
 *    memories and remove that coupling.
 *  - Wording is realistic "we changed our mind and describe it differently now" prose,
 *    NOT artificially orthogonal tokens engineered to manufacture a win.
 *
 * Run: node benchmarks/e3.2/multihop_benchmark.mjs   (after `npm run build`)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const home = mkdtempSync(join(tmpdir(), 'hippo-e3.2-bench-'));
// Isolate from the user's real global store ($HIPPO_HOME / ~/.hippo): point HIPPO_HOME at
// an empty temp dir so recall cannot pull in the operator's actual global memories (codex P2).
const globalHome = mkdtempSync(join(tmpdir(), 'hippo-e3.2-bench-global-'));
const env = { ...process.env, HIPPO_HOME: globalHome };
function hippo(args) {
  return execFileSync('node', [CLI, ...args], { cwd: home, encoding: 'utf8', env });
}
function memIdFrom(out) {
  const m = out.match(/memory:\s+(\S+)/);
  if (!m) throw new Error('no memory id in decide output: ' + out);
  return m[1];
}
function rankOf(results, memId) {
  const i = results.findIndex((r) => r.id === memId);
  return i < 0 ? null : i + 1; // 1-based, null = absent
}

// 5 decision lineages: predecessor superseded by successor, lexically distinct wording
// for the same underlying decision.
const chains = [
  { pred: 'Adopt Redis as the primary session cache for the web tier',
    succ: 'Move ephemeral login state into Postgres unlogged tables instead' },
  { pred: 'Bill customers monthly in arrears with Stripe metered subscriptions',
    succ: 'Capture revenue through prepaid credit packs that roll over each cycle' },
  { pred: 'Run a nightly batch pipeline into a Snowflake analytics warehouse',
    succ: 'Stream change-data-capture events into an embedded DuckDB at the edge' },
  { pred: 'Authenticate service to service traffic with long lived API keys',
    succ: 'Issue short lived workload identity tokens for machine callers' },
  { pred: 'Deploy the monolith to one region behind a single load balancer',
    succ: 'Spread the application across three availability zones with anycast routing' },
];

hippo(['init', '--no-hooks', '--no-schedule', '--no-learn']);
// distractor noise so the budget cut is meaningful
for (let i = 0; i < 30; i++) {
  hippo(['remember', `routine operations note ${i}: dashboards, oncall rotations, log retention windows`]);
}
for (const c of chains) {
  c.predMem = memIdFrom(hippo(['decide', c.pred]));
  hippo(['decide', c.succ, '--supersedes', c.predMem]);
}
const extract = hippo(['graph', 'extract']);

const BUDGET = process.argv[2] ?? '300'; // tokens; tight enough that the cut bites
let baseHits = 0, hopHits = 0;
const rows = [];
for (const c of chains) {
  const base = JSON.parse(hippo(['recall', c.succ, '--include-superseded', '--budget', BUDGET, '--json']));
  const hop = JSON.parse(hippo(['recall', c.succ, '--include-superseded', '--hops', '1', '--budget', BUDGET, '--json']));
  const baseRank = rankOf(base.results, c.predMem);
  const hopRank = rankOf(hop.results, c.predMem);
  const hopRow = hop.results.find((r) => r.id === c.predMem);
  if (baseRank !== null) baseHits++;
  if (hopRank !== null) hopHits++;
  rows.push({
    query: c.succ.slice(0, 38),
    predInBase: baseRank !== null ? `rank ${baseRank}` : 'MISS',
    predInHops: hopRank !== null ? `rank ${hopRank}` : 'MISS',
    viaGraph: hopRow?.graphVia ?? null,
  });
}
console.log('graph extract:', extract.trim().split('\n').pop());
console.log(JSON.stringify({
  budget: BUDGET, n: chains.length,
  predecessor_recall_baseline: `${baseHits}/${chains.length}`,
  predecessor_recall_hops1: `${hopHits}/${chains.length}`,
  rows,
}, null, 2));
rmSync(home, { recursive: true, force: true });
rmSync(globalHome, { recursive: true, force: true });
