/**
 * v1.7.7 -- Analyze the 4-condition × 20-seed eval per the pre-registration:
 * docs/evals/2026-05-09-v1.7.7-goal-stack-eval-prereg.md.
 *
 * Reads the 4 result JSONs from results/v1.7.7-eval-C{0,1,2,3}-... directories.
 * Computes the paired permutation CI on Δ = mean_late(C2) − mean_late(C3).
 * Applies the mechanical decision rule via the pure `computeVerdict` helper
 * (post-review P1-2: tie-degeneracy guard; post-review P1-3: exact enumeration
 * sensitivity check when the Monte Carlo result is within 2pp of a decision
 * boundary).
 * Prints a markdown-ready summary.
 *
 * Run: node benchmarks/sequential-learning/analyze-v1.7.7.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mean, stdDev, ciHalfWidth95, pairedPermutationCI } from './aggregate.mjs';

/**
 * Pure verdict computation. No I/O. Testable in isolation.
 *
 * Post-review P1-2: `tiePass` flag handles tie-degeneracy at N=4 lattice.
 * When >14 of 20 paired diffs are exactly 0 (`tiePass=false`), the permutation
 * CI is underpowered; verdict is mechanically NOT_SUPPORTED with `degenerate`
 * flag in the structured JSON summary. Caller is responsible for computing
 * `tiePass` from the paired-diff array and passing it in.
 *
 * @param {{c2Late:number, c3Late:number, delta:number, ciLow:number, ciHigh:number,
 *          hookFailures:{push:number, complete:number}|null,
 *          sanityPass:boolean,
 *          tiePass:boolean}} input
 * @returns {'SUPPORTED' | 'NOT_SUPPORTED' | 'SANITY_FAIL' | 'HOOK_FAIL'}
 */
export function computeVerdict({ c2Late, c3Late, delta, ciLow, ciHigh, hookFailures, sanityPass, tiePass }) {
  if (!sanityPass) return 'SANITY_FAIL';
  if ((hookFailures?.push ?? 0) > 0 || (hookFailures?.complete ?? 0) > 0) return 'HOOK_FAIL';
  if (tiePass === false) return 'NOT_SUPPORTED'; // degenerate, surface in result doc
  if (delta >= 0.10 && ciLow > 0) return 'SUPPORTED';
  return 'NOT_SUPPORTED';
}

/**
 * Exact paired sign-flip enumeration over 2^n combinations. For n=20 this is
 * 2^20 ≈ 1M, computable in <1s. Returns the same {ciLow, ciHigh, deltaMean}
 * shape as `pairedPermutationCI` for direct comparison. Used only when the
 * Monte Carlo result is within 2pp of a decision boundary (post-review P1-3).
 *
 * @param {number[]} c2 - per-seed C2 late rates
 * @param {number[]} c3 - per-seed C3 late rates
 * @param {number} alpha - 0.05 for 95% CI
 * @returns {{deltaMean:number, ciLow:number, ciHigh:number, exact:true}}
 */
export function exactPairedPermutationCI(c2, c3, alpha = 0.05) {
  if (c2.length !== c3.length) throw new Error('c2/c3 length mismatch');
  const n = c2.length;
  if (n > 22) throw new Error(`exact enumeration impractical for n=${n} (2^n > 4M)`);
  const diffs = c2.map((v, i) => v - c3[i]);
  const observed = diffs.reduce((a, b) => a + b, 0) / n;
  const allMeans = [];
  const total = 1 << n; // 2^n
  for (let mask = 0; mask < total; mask++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += (mask & (1 << i)) ? -diffs[i] : diffs[i];
    }
    allMeans.push(sum / n);
  }
  allMeans.sort((a, b) => a - b);
  const meanOfNull = allMeans.reduce((a, b) => a + b, 0) / total;
  const loIdx = Math.floor(total * (alpha / 2));
  const hiIdx = Math.ceil(total * (1 - alpha / 2)) - 1;
  return {
    deltaMean: observed,
    ciLow: observed + (allMeans[loIdx] - meanOfNull),
    ciHigh: observed + (allMeans[hiIdx] - meanOfNull),
    exact: true,
  };
}

const __dirname = import.meta.dirname ?? new URL('.', import.meta.url).pathname.replace(/^\//, '');
const RESULTS_BASE = join(__dirname, '..', '..', 'results');

function loadLatestJson(dirName) {
  const dir = join(RESULTS_BASE, dirName);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  files.sort();
  const latest = files[files.length - 1];
  return JSON.parse(readFileSync(join(dir, latest), 'utf-8'));
}

// 5-bucket histogram for late-phase rates on the N=4 lattice (0, 0.25, 0.5, 0.75, 1.0).
function latticeHistogram(rates) {
  const buckets = { '0.0': 0, '0.25': 0, '0.5': 0, '0.75': 0, '1.0': 0 };
  for (const r of rates) {
    // Round to nearest lattice value to absorb floating-point noise.
    const rounded = Math.round(r * 4) / 4;
    let key;
    if (rounded === 0) key = '0.0';
    else if (rounded === 0.25) key = '0.25';
    else if (rounded === 0.5) key = '0.5';
    else if (rounded === 0.75) key = '0.75';
    else if (rounded === 1) key = '1.0';
    else key = '0.0'; // off-lattice fallback (should not happen at N=4)
    buckets[key]++;
  }
  return buckets;
}

// Only run main() when this file is executed directly (not when imported by tests).
const isMain = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    const thisFile = new URL(import.meta.url).pathname;
    // Normalise Windows path quirk: leading '/C:/...' from URL pathname.
    const norm = (p) => p.replace(/^\/([A-Za-z]:)/, '$1').replace(/\\/g, '/');
    return norm(argv1) === norm(thisFile);
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}

function main() {
  const c0 = loadLatestJson('v1.7.7-eval-C0-none');
  const c1 = loadLatestJson('v1.7.7-eval-C1-static');
  const c2 = loadLatestJson('v1.7.7-eval-C2-hippo-base');
  const c3 = loadLatestJson('v1.7.7-eval-C3-hippo-goalstack');

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

  // Hook-failure gate (handled inside computeVerdict; kept here for the human-readable line)
  const hookFailuresOk =
    (e3.hookFailures?.push ?? 0) === 0 && (e3.hookFailures?.complete ?? 0) === 0;

  // Paired permutation CI on Δ = late_C2 − late_C3 (positive Δ = goal-stack helped)
  const perm = pairedPermutationCI(e2.late, e3.late, 0.05, 10_000);

  // Per-seed paired diffs (C2 - C3) for tie-degeneracy gate + histogram.
  const pairedDiffs = e2.late.map((v, i) => v - e3.late[i]);
  const zeroDiffCount = pairedDiffs.filter((d) => d === 0).length;
  const tiePass = pairedDiffs.length > 0 && zeroDiffCount / pairedDiffs.length <= 0.70;

  // Lattice histograms for C2 and C3 late-phase rates.
  const c2Histogram = latticeHistogram(e2.late);
  const c3Histogram = latticeHistogram(e3.late);

  const delta = perm.deltaMean;
  const ciLow = perm.ciLow;
  const ciHigh = perm.ciHigh;

  // Post-review P1-3: exact enumeration when within 2pp of decision boundary.
  const nearBoundary = Math.abs(delta - 0.10) < 0.02 || Math.abs(ciLow) < 0.02;
  let exact = null;
  if (nearBoundary) {
    exact = exactPairedPermutationCI(e2.late, e3.late, 0.05);
  }

  const verdict = computeVerdict({
    c2Late: rows[2].lateMean,
    c3Late: rows[3].lateMean,
    delta,
    ciLow,
    ciHigh,
    hookFailures: e3.hookFailures,
    sanityPass,
    tiePass,
  });

  // Human-readable decision string for the markdown report.
  const HARMS = ciHigh < 0;
  let decision;
  if (verdict === 'SANITY_FAIL') decision = 'STOP — sanity gate failed (C2 late outside [4%, 24%])';
  else if (verdict === 'HOOK_FAIL') decision = 'STOP — hook failures detected, run contaminated';
  else if (verdict === 'SUPPORTED') decision = 'HYPOTHESIS SUPPORTED';
  else if (!tiePass) decision = 'HYPOTHESIS NOT SUPPORTED — degenerate (>70% paired diffs are zero on N=4 lattice)';
  else if (HARMS) decision = 'HYPOTHESIS NOT SUPPORTED + goal-stack measurably HARMS performance (Δ<0, upper-CI<0) — flag for v1.8';
  else decision = 'HYPOTHESIS NOT SUPPORTED';

  // Output
  const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'NaN');
  const pp = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + 'pp' : 'NaN');

  console.log('# v1.7.7 Goal-Stack Eval — Result\n');
  console.log(`**Run:** 2026-05-09`);
  console.log(`**Pre-registration:** docs/evals/2026-05-09-v1.7.7-goal-stack-eval-prereg.md`);
  console.log(`**Claim inventory:** docs/evals/2026-05-09-v1.7.7-claim-inventory.md`);
  console.log(`**Decision applied:** ${decision}\n`);

  console.log('## Decision\n');
  if (verdict === 'SUPPORTED') {
    console.log(`Δ = ${pp(delta)} ≥ 10pp AND lower-CI ${pp(ciLow)} > 0pp → HYPOTHESIS SUPPORTED.`);
  } else if (verdict === 'NOT_SUPPORTED') {
    if (!tiePass) {
      console.log(`Tie-degeneracy guard tripped: ${zeroDiffCount}/${pairedDiffs.length} paired diffs are exactly zero on the N=4 lattice; permutation CI is underpowered. → HYPOTHESIS NOT SUPPORTED (degenerate).`);
    } else {
      console.log(`Δ = ${pp(delta)} ${delta >= 0.10 ? 'meets' : 'does NOT meet'} the ≥10pp threshold; CI [${pp(ciLow)}, ${pp(ciHigh)}] ${ciLow > 0 ? 'excludes' : 'includes'} 0. → HYPOTHESIS NOT SUPPORTED.`);
    }
  } else {
    console.log(decision);
  }
  console.log('');

  console.log('## Measured numbers (20 seeds, 4 conditions)\n');
  console.log('| Condition | Early mean (CI) | Mid mean (CI) | Late mean (CI) |');
  console.log('|-----------|-----------------|---------------|----------------|');
  for (const r of rows) {
    console.log(`| ${r.name} | ${pct(r.earlyMean)} (±${pp(r.earlyCI)}) | ${pct(r.midMean)} (±${pp(r.midCI)}) | ${pct(r.lateMean)} (±${pp(r.lateCI)}) |`);
  }
  console.log('');
  console.log(`Paired Δ on late-phase (C2 − C3): **Δ = ${pp(delta)}** (95% permutation CI [${pp(ciLow)}, ${pp(ciHigh)}]).`);
  console.log('');

  console.log('## Paired-diff histogram (N=4 lattice)\n');
  console.log('| Lattice value | C2 late count | C3 late count |');
  console.log('|---------------|---------------|---------------|');
  for (const k of ['0.0', '0.25', '0.5', '0.75', '1.0']) {
    console.log(`| ${k} | ${c2Histogram[k]} | ${c3Histogram[k]} |`);
  }
  console.log('');
  console.log(`Tie-degeneracy: ${zeroDiffCount}/${pairedDiffs.length} paired diffs are zero (${tiePass ? 'PASS' : 'FAIL'} — threshold ≤70% zero).`);
  console.log('');

  if (exact) {
    console.log('## Exact-enumeration sensitivity check (post-review P1-3)\n');
    console.log(`Monte Carlo result is within 2pp of a decision boundary (Δ=${pp(delta)}, ciLow=${pp(ciLow)}); running exact 2^${e2.late.length} sign-flip enumeration.`);
    console.log('');
    console.log(`Exact: Δ = ${pp(exact.deltaMean)}, 95% CI [${pp(exact.ciLow)}, ${pp(exact.ciHigh)}].`);
    console.log(`Monte Carlo: Δ = ${pp(delta)}, 95% CI [${pp(ciLow)}, ${pp(ciHigh)}].`);
    console.log('');
  }

  console.log(`Hook failures: C3.push=${e3.hookFailures?.push ?? 'n/a'}, C3.complete=${e3.hookFailures?.complete ?? 'n/a'}.`);
  console.log(`Sanity gate (C2 late ∈ [4%, 24%]): ${sanityPass ? 'PASS' : 'FAIL'} (measured ${pct(rows[2].lateMean)}).`);
  console.log('');

  console.log('## Reproducibility anchors\n');
  console.log('<!-- Task 5 fills this block from /tmp/v1.7.7-eval-anchors.md -->');
  console.log('');

  console.log('## Raw artifacts\n');
  console.log('- `results/v1.7.7-eval-C0-none/benchmark-*.json`');
  console.log('- `results/v1.7.7-eval-C1-static/benchmark-*.json`');
  console.log('- `results/v1.7.7-eval-C2-hippo-base/benchmark-*.json`');
  console.log('- `results/v1.7.7-eval-C3-hippo-goalstack/benchmark-*.json`');

  // Also write structured JSON for programmatic use
  const summary = {
    verdict,
    decision,
    sanityPass,
    hookFailuresOk,
    tiePass,
    degenerate: !tiePass,
    conditions: rows,
    pairedDelta: { mean: delta, ciLow, ciHigh },
    pairedDiffs,
    c2Histogram,
    c3Histogram,
    exact,
    hookFailures: e3.hookFailures,
  };
  process.stderr.write('\n--- JSON SUMMARY ---\n' + JSON.stringify(summary, null, 2) + '\n');
}
