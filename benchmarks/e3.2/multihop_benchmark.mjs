#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const home = mkdtempSync(join(tmpdir(), 'hippo-e3.2-bench-'));
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
  return i < 0 ? null : i + 1;
}

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
for (let i = 0; i < 30; i++) {
  hippo(['remember', `routine operations note ${i}: dashboards, oncall rotations, log retention windows`]);
}
for (const c of chains) {
  c.predMem = memIdFrom(hippo(['decide', c.pred]));
  hippo(['decide', c.succ, '--supersedes', c.predMem]);
}
const extract = hippo(['graph', 'extract']);

const BUDGET = process.argv[2] ?? '300';
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
