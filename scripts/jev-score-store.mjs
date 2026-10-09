#!/usr/bin/env node
/** Lane 1+2 of docs/EXPERIMENT-PROTOCOL.md: score real stored memories with Jev
 *  and test the durability probability against hippo's own labels AND against
 *  the free baselines. Usage: node scripts/jev-score-store.mjs [--limit N] */

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { judgeAll } from '../dist/eval/judgment.js';

const COST_PER_CALL_USD = 0.0004;
const NOISE_FLOOR_AUC = 0.07;
const BOOTSTRAP_DRAWS = 2000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set.');
  process.exit(1);
}

const dbPath = arg('db', join(homedir(), '.hippo', 'hippo.db'));
const limit = Number(arg('limit', '250'));
const seed = Number(arg('seed', '20260918'));
const db = new DatabaseSync(dbPath);

let rngState = seed;
/** Deterministic draw so the pre-registered sample is reproducible. */
function rng() {
  rngState = (rngState * 1664525 + 1013904223) % 4294967296;
  return rngState / 4294967296;
}

const sourceFilter = arg('source', null);
const all = db.prepare(`
  SELECT id, content, source, retrieval_count, outcome_positive, outcome_negative,
         pinned, schema_fit, created,
         julianday('now') - julianday(created) AS age_days
  FROM memories
  WHERE kind != 'archived' AND length(content) > 20
    AND (? IS NULL OR source = ?)
`).all(sourceFilter, sourceFilter);
if (sourceFilter) console.log(`DIAGNOSTIC LANE: source = '${sourceFilter}' (not a pre-registered verdict lane)`);

const rows = all
  .map((r) => ({ r, k: rng() }))
  .sort((a, b) => a.k - b.k)
  .slice(0, limit)
  .map((x) => x.r);

console.log(`Scoring ${rows.length} of ${all.length} memories from ${dbPath} (seed ${seed})`);
console.log(`Estimated cost: $${(rows.length * COST_PER_CALL_USD).toFixed(4)}\n`);

const started = Date.now();
const judgments = await judgeAll(rows.map((r) => r.content), { apiKey, concurrency: 8 });
const elapsed = (Date.now() - started) / 1000;

const scored = rows.map((r, i) => ({ row: r, j: judgments[i] })).filter((x) => x.j !== null);
const failed = rows.length - scored.length;
if (scored.length < 50) {
  console.error(`Only ${scored.length} calls succeeded (${failed} failed). Too thin to judge; aborting.`);
  process.exit(1);
}

const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  n/a');

/** Probability a random useful memory outscores a random useless one. */
function auc(items, score, label) {
  const pos = [];
  const neg = [];
  for (const x of items) (label(x.row) ? pos : neg).push(score(x));
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

const LABELS = {
  'useful (raw)': (r) => r.retrieval_count >= 3 || r.outcome_positive > 0 || r.pinned === 1,
  'useful (age-normalised)': (r) => r.retrieval_count / Math.max(r.age_days, 1) >= 0.05 || r.outcome_positive > 0,
  'positive outcome only': (r) => r.outcome_positive > 0,
};

const SCORERS = {
  'Jev durable': (x) => x.j.durable,
  'content length': (x) => x.row.content.length,
  'source == cli': (x) => (x.row.source === 'cli' || x.row.source === 'cli-global' ? 1 : 0),
  'schema_fit (incumbent)': (x) => x.row.schema_fit,
  'coin flip': () => rng(),
};

console.log('AUC by scorer and label  (0.500 = chance, noise floor +-0.07)\n');
const header = ['scorer'.padEnd(24), ...Object.keys(LABELS).map((l) => l.padStart(24))].join('');
console.log(header);
const table = {};
for (const [sName, score] of Object.entries(SCORERS)) {
  const cells = [];
  for (const [lName, label] of Object.entries(LABELS)) {
    const a = auc(scored, score, label);
    table[`${sName} | ${lName}`] = a;
    cells.push(fmt(a).padStart(24));
  }
  console.log(sName.padEnd(24) + cells.join(''));
}

/** Paired bootstrap: resample rows, recompute the Jev-minus-baseline delta. */
function pairedDelta(label, baselineName) {
  const baseline = SCORERS[baselineName];
  const jev = SCORERS['Jev durable'];
  const point = auc(scored, jev, label) - auc(scored, baseline, label);
  const deltas = [];
  for (let d = 0; d < BOOTSTRAP_DRAWS; d++) {
    const sample = Array.from({ length: scored.length }, () => scored[Math.floor(rng() * scored.length)]);
    const v = auc(sample, jev, label) - auc(sample, baseline, label);
    if (Number.isFinite(v)) deltas.push(v);
  }
  deltas.sort((a, b) => a - b);
  return { point, lo: deltas[Math.floor(deltas.length * 0.025)], hi: deltas[Math.floor(deltas.length * 0.975)] };
}

console.log('\nPrimary verdict — Jev vs the best baseline, paired bootstrap 95% CI\n');
const verdicts = {};
for (const [lName, label] of Object.entries(LABELS)) {
  const competitors = Object.keys(SCORERS).filter((s) => s !== 'Jev durable');
  const best = competitors.reduce((a, b) => (auc(scored, SCORERS[a], label) >= auc(scored, SCORERS[b], label) ? a : b));
  const d = pairedDelta(label, best);
  const passes = d.point > NOISE_FLOOR_AUC && d.lo > 0;
  verdicts[lName] = { best_baseline: best, ...d, passes };
  console.log(
    `${lName.padEnd(24)} best baseline: ${best.padEnd(24)} ` +
    `delta ${d.point >= 0 ? '+' : ''}${fmt(d.point)}  CI [${fmt(d.lo)}, ${fmt(d.hi)}]  ` +
    `${passes ? 'PASS' : 'FAIL (rule: delta > 0.07 and CI excludes 0)'}`,
  );
}

const kinds = {};
for (const x of scored) kinds[x.j.kind] = (kinds[x.j.kind] ?? 0) + 1;
const flat = scored.filter((x) => x.row.schema_fit === 0.5).map((x) => x.j.durable);
console.log(`\nJev kind distribution: ${JSON.stringify(kinds)}`);
console.log(`On the flat schema_fit 0.5 default: ${flat.length}/${scored.length} rows, ` +
  (flat.length ? `Jev spreads them ${fmt(Math.min(...flat))}..${fmt(Math.max(...flat))}` : 'none'));
console.log(`Failed calls: ${failed}/${rows.length}   wall: ${elapsed.toFixed(1)}s   cost: $${(rows.length * COST_PER_CALL_USD).toFixed(4)}`);

const outDir = join(process.cwd(), 'results');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `jev-store-score-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(outPath, JSON.stringify({
  protocol: 'docs/EXPERIMENT-PROTOCOL.md',
  db: dbPath, seed, drawn: rows.length, scored: scored.length, failed,
  auc_table: table, verdicts, kinds, elapsed_s: elapsed,
  rows: scored.map((x) => ({
    id: x.row.id, source: x.row.source, retrieval_count: x.row.retrieval_count,
    outcome_positive: x.row.outcome_positive, pinned: x.row.pinned,
    age_days: Math.round(x.row.age_days), schema_fit_now: x.row.schema_fit, jev: x.j,
  })),
}, null, 2));
console.log(`\nWrote ${outPath}`);
db.close();
