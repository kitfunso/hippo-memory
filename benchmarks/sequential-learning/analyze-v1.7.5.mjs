#!/usr/bin/env node
/**
 * v1.7.5 -- Analyze the 4-condition × 20-seed eval per the pre-registration:
 * docs/evals/2026-05-07-v1.7.5-goal-stack-eval-prereg.md.
 *
 * Reads the 4 result JSONs from results/v1.7.5-eval-C{0,1,2,3}-... directories.
 * Computes the paired permutation CI on Δ = mean_late(C2) − mean_late(C3).
 * Applies the mechanical decision rule.
 * Prints a markdown-ready summary.
 *
 * Run: node benchmarks/sequential-learning/analyze-v1.7.5.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mean, stdDev, ciHalfWidth95, pairedPermutationCI } from './aggregate.mjs';

const __dirname = import.meta.dirname ?? new URL('.', import.meta.url).pathname.replace(/^\//, '');
const RESULTS_BASE = join(__dirname, '..', '..', 'results');

function loadLatestJson(dirName) {
  const dir = join(RESULTS_BASE, dirName);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  files.sort();
  const latest = files[files.length - 1];
  return JSON.parse(readFileSync(join(dir, latest), 'utf-8'));
}

const c0 = loadLatestJson('v1.7.5-eval-C0-none');
const c1 = loadLatestJson('v1.7.5-eval-C1-static');
const c2 = loadLatestJson('v1.7.5-eval-C2-hippo-base');
const c3 = loadLatestJson('v1.7.5-eval-C3-hippo-goalstack');

const conditions = { c0, c1, c2, c3 };

function extractSeedRates(condRoot) {
  // Output schema written by run.mjs::runAdapter when n-seeds>1.
  // Expected shape: { conditions: { <name>: { seeds: [{seed, phases:{early,mid,late}, overall}], phase_aggregate: ... } } }
  // Single-condition runs (output dir per condition) collapse to that one condition.
  const cond = condRoot.conditions ?? {};
  const condName = Object.keys(cond)[0];
  const seeds = cond[condName]?.seeds ?? [];
  return {
    condName,
    seeds,
    overall: seeds.map((s) => s.overall),
    early: seeds.map((s) => s.phases.early),
    mid: seeds.map((s) => s.phases.mid),
    late: seeds.map((s) => s.phases.late),
    hookFailures: cond[condName]?.hook_failures ?? null,
  };
}

const e0 = extractSeedRates(c0);
const e1 = extractSeedRates(c1);
const e2 = extractSeedRates(c2);
const e3 = extractSeedRates(c3);

function row(name, e) {
  return {
    name,
    earlyMean: mean(e.early),
    earlyCI: ciHalfWidth95(e.early),
    midMean: mean(e.mid),
    midCI: ciHalfWidth95(e.mid),
    lateMean: mean(e.late),
    lateCI: ciHalfWidth95(e.late),
    overallMean: mean(e.overall),
  };
}

const rows = [
  row('C0 none', e0),
  row('C1 static', e1),
  row('C2 hippo-base', e2),
  row('C3 hippo+goalstack', e3),
];

// Sanity gate: C2 late within [0.04, 0.24]
const sanityPass = e2.late.length === 20 && rows[2].lateMean >= 0.04 && rows[2].lateMean <= 0.24;

// Hook-failure gate
const hookFailuresOk =
  (e3.hookFailures?.push ?? 0) === 0 && (e3.hookFailures?.complete ?? 0) === 0;

// Paired permutation CI on Δ = late_C2 − late_C3 (positive Δ = goal-stack helped)
const perm = pairedPermutationCI(e2.late, e3.late, 0.05, 10_000);

// Decision rule
const delta = perm.deltaMean;
const ciLow = perm.ciLow;
const ciHigh = perm.ciHigh;
const SUPPORTED = delta >= 0.10 && ciLow > 0;
const HARMS = ciHigh < 0;

let decision;
if (!sanityPass) decision = 'STOP — sanity gate failed (C2 late outside [4%, 24%])';
else if (!hookFailuresOk) decision = 'STOP — hook failures detected, run contaminated';
else if (SUPPORTED) decision = 'HYPOTHESIS SUPPORTED';
else if (HARMS) decision = 'HYPOTHESIS NOT SUPPORTED + goal-stack measurably HARMS performance (Δ<0, upper-CI<0) — flag for v1.8';
else decision = 'HYPOTHESIS NOT SUPPORTED';

// Output
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'NaN');
const pp = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + 'pp' : 'NaN');

console.log('# v1.7.5 Goal-Stack Eval — Result\n');
console.log(`**Run:** 2026-05-07`);
console.log(`**Pre-registration:** docs/evals/2026-05-07-v1.7.5-goal-stack-eval-prereg.md`);
console.log(`**Claim inventory:** docs/evals/2026-05-07-v1.7.5-claim-inventory.md`);
console.log(`**Decision applied:** ${decision}\n`);
console.log('## Measured numbers (20 seeds, 4 conditions)\n');
console.log('| Condition | Early mean (CI) | Mid mean (CI) | Late mean (CI) |');
console.log('|-----------|-----------------|---------------|----------------|');
for (const r of rows) {
  console.log(`| ${r.name} | ${pct(r.earlyMean)} (±${pp(r.earlyCI)}) | ${pct(r.midMean)} (±${pp(r.midCI)}) | ${pct(r.lateMean)} (±${pp(r.lateCI)}) |`);
}
console.log('');
console.log(`Paired Δ on late-phase (C2 − C3): **Δ = ${pp(delta)}** (95% permutation CI [${pp(ciLow)}, ${pp(ciHigh)}]).`);
console.log('');
console.log(`Hook failures: C3.push=${e3.hookFailures?.push ?? 'n/a'}, C3.complete=${e3.hookFailures?.complete ?? 'n/a'}.`);
console.log(`Sanity gate (C2 late ∈ [4%, 24%]): ${sanityPass ? 'PASS' : 'FAIL'} (measured ${pct(rows[2].lateMean)}).`);
console.log('');
console.log('## Decision\n');
if (decision.startsWith('HYPOTHESIS SUPPORTED')) {
  console.log(`Δ = ${pp(delta)} ≥ 10pp AND lower-CI ${pp(ciLow)} > 0pp → HYPOTHESIS SUPPORTED.`);
} else if (decision.startsWith('HYPOTHESIS NOT SUPPORTED')) {
  console.log(`Δ = ${pp(delta)} ${delta >= 0.10 ? 'meets' : 'does NOT meet'} the ≥10pp threshold; CI [${pp(ciLow)}, ${pp(ciHigh)}] ${ciLow > 0 ? 'excludes' : 'includes'} 0. → HYPOTHESIS NOT SUPPORTED.`);
} else {
  console.log(decision);
}
console.log('');
console.log('## Raw artifacts\n');
console.log('- `results/v1.7.5-eval-C0-none/benchmark-*.json`');
console.log('- `results/v1.7.5-eval-C1-static/benchmark-*.json`');
console.log('- `results/v1.7.5-eval-C2-hippo-base/benchmark-*.json`');
console.log('- `results/v1.7.5-eval-C3-hippo-goalstack/benchmark-*.json`');

// Also write structured JSON for programmatic use
const summary = {
  decision,
  sanityPass,
  hookFailuresOk,
  conditions: rows,
  pairedDelta: { mean: delta, ciLow, ciHigh },
  hookFailures: e3.hookFailures,
};
process.stderr.write('\n--- JSON SUMMARY ---\n' + JSON.stringify(summary, null, 2) + '\n');
