#!/usr/bin/env node
/**
 * v1.7.6 -- Calibration sweep for the discriminating-workload variant.
 *
 * Runs C2 (hippo-base, no goal-stack) at a fixed list of budget candidates
 * with N=10 calibration seeds (post-review P0-1 -- ciHalfWidth95 returns 0
 * for n<5; n=10 gives a usable t-band). Calibration seeds: 1000+10000+i
 * for i in 0..9 (post-review P1-1 -- offset bumped from 100 to 10000 for
 * larger input distance vs hypothesis seeds 1000+i for i in 0..19).
 *
 * Picks B* mechanically per the pre-registered selection rule:
 *   B* = LARGEST budget where (mean late ∈ [0.04, 0.24]) AND (lower-CI > 0)
 *        AND mean(len(results)) >= 1 across calibration seeds (P1-4
 *        starvation guard).
 *
 * Outputs:
 *   - stdout: markdown table + B* announcement
 *   - <output>/calibration-result.json: structured per-budget rows
 *
 * Usage:
 *   node benchmarks/sequential-learning/calibrate.mjs \
 *     --budgets 200,400,600,800,1000 \
 *     --n-seeds 10 \
 *     --output benchmarks/sequential-learning/results/v1.7.6-calibration/
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mean, ciHalfWidth95 } from './aggregate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// B* selection rule (pre-registered in
// docs/evals/2026-05-07-v1.7.6-goal-stack-eval-prereg.md).
// ---------------------------------------------------------------------------

const BAND_LOW = 0.04;
const BAND_HIGH = 0.24;

/**
 * @param {Array<{budget:number, lateMean:number, lateCI:number, starved?:boolean}>} candidates
 * @returns {{budget:number|null, reason:string}}
 *
 * Post-review P1-4 -- starvation guard: if a candidate is flagged `starved`
 * (mean recall surface < 1 across calibration seeds), exclude before applying
 * the band rule.
 */
export function selectBStar(candidates) {
  if (!candidates || candidates.length === 0) {
    return { budget: null, reason: 'No candidates supplied.' };
  }
  // Sort descending by budget; pick the first that qualifies.
  const sorted = [...candidates].sort((a, b) => b.budget - a.budget);
  for (const c of sorted) {
    if (c.starved === true) continue; // P1-4 starvation exclusion
    const lowerCI = c.lateMean - c.lateCI;
    if (
      c.lateMean >= BAND_LOW &&
      c.lateMean <= BAND_HIGH &&
      lowerCI > 0
    ) {
      return {
        budget: c.budget,
        reason: `largest budget in band [${BAND_LOW}, ${BAND_HIGH}] with lower-CI ${lowerCI.toFixed(4)} > 0 (not starved)`,
      };
    }
  }
  return {
    budget: null,
    reason: `No candidate satisfies (mean ∈ [${BAND_LOW}, ${BAND_HIGH}]) AND (lower-CI > 0) AND (not starved).`,
  };
}

// ---------------------------------------------------------------------------
// CLI driver (no-op when imported from tests)
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    budgets: [200, 400, 600, 800, 1000],
    nSeeds: 10, // post-review P0-1 -- bumped from 5 to 10 for usable CI.
    output: join(__dirname, 'results', 'v1.7.6-calibration'),
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--budgets' && args[i + 1]) {
      opts.budgets = args[++i].split(',').map((s) => parseInt(s, 10));
    } else if (args[i] === '--n-seeds' && args[i + 1]) {
      opts.nSeeds = parseInt(args[++i], 10);
    } else if (args[i] === '--output' && args[i + 1]) {
      opts.output = args[++i];
    }
  }
  return opts;
}

function deriveCalibrationSeeds(n) {
  // Post-review P1-1 -- offset bumped from 100 to 10000 for larger input
  // distance vs hypothesis seeds (1000+i for i in 0..19). Pairwise non-collision
  // verified by tests/sl-calibrate.test.ts.
  return Array.from({ length: n }, (_, i) =>
    (Math.imul(0x9E3779B9, (1000 + 10000 + i) >>> 0)) >>> 0,
  );
}

function runOneBudget(budget, seeds, outputBase) {
  const outDir = join(outputBase, `budget-${budget}`);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // Post-review P0-3 -- run.mjs sets `seedRuns: null` for single-seed runs
  // (run.mjs:548 -- `seedList.length > 1 ? seedRuns : null`). The single-seed
  // late rate lives at j.conditions[condName].phases.late, NOT at
  // j.conditions[condName].seeds[0].phases.late. Reading the wrong path
  // crashes silently (`Cannot read properties of null`).
  //
  // We invoke run.mjs once per calibration seed via --seed <hash>.
  const seedRates = [];
  const seedResultCounts = []; // post-review P1-4 -- starvation guard.
  for (const seed of seeds) {
    const seedDir = join(outDir, `seed-${seed}`);
    if (!existsSync(seedDir)) mkdirSync(seedDir, { recursive: true });
    execSync(
      `node "${join(__dirname, 'run.mjs')}" --adapter hippo --seed ${seed} --budget ${budget} --output "${seedDir}"`,
      { stdio: 'inherit' },
    );
    // Read the resulting JSON and extract late-phase rate for this single seed.
    const files = readdirSync(seedDir).filter((f) => f.endsWith('.json'));
    if (files.length === 0) throw new Error(`No JSON output in ${seedDir}`);
    files.sort();
    const j = JSON.parse(readFileSync(join(seedDir, files[files.length - 1]), 'utf-8'));
    const condName = Object.keys(j.conditions)[0];
    // Single-seed path -- read directly from `phases.late`.
    const lateRate = j.conditions[condName].phases.late;
    if (typeof lateRate !== 'number') {
      throw new Error(
        `runOneBudget: phases.late not numeric for ${seedDir} (got ${typeof lateRate}). ` +
        `Schema may have changed; verify run.mjs:539-550 output shape.`,
      );
    }
    seedRates.push(lateRate);

    // Starvation guard -- count avg results returned per trap encounter.
    // results[].memoryRecalled is true iff recall returned a matching memory;
    // we approximate avg recall surface from `results.length` of trap tasks
    // (which is fixed at ~25) vs how many had memoryRecalled. Real per-trap
    // result-count is not surfaced in run.mjs JSON; use a simpler heuristic:
    // if zero traps had memoryRecalled across the whole seed, the budget
    // is starving the BM25 ranker.
    const trapResults = (j.conditions[condName].results ?? []).filter(
      (r) => r.trapCategory !== null,
    );
    const recalledCount = trapResults.filter((r) => r.memoryRecalled).length;
    seedResultCounts.push(recalledCount);
  }
  const starvationFlag =
    seedResultCounts.length > 0 &&
    seedResultCounts.reduce((a, b) => a + b, 0) / seedResultCounts.length < 1;
  return {
    budget,
    seedRates,
    seedResultCounts,
    starved: starvationFlag,
    lateMean: mean(seedRates),
    lateCI: ciHalfWidth95(seedRates),
  };
}

async function main() {
  const opts = parseArgs();
  if (!existsSync(opts.output)) mkdirSync(opts.output, { recursive: true });

  const seeds = deriveCalibrationSeeds(opts.nSeeds);
  console.log(`Calibration seeds (n=${opts.nSeeds}): ${seeds.join(', ')}`);
  console.log(`Budget candidates: ${opts.budgets.join(', ')}`);
  console.log('');

  const rows = [];
  for (const budget of opts.budgets) {
    console.log(`--- budget=${budget} ---`);
    const row = runOneBudget(budget, seeds, opts.output);
    rows.push(row);
    console.log(
      `  late mean=${(row.lateMean * 100).toFixed(2)}% ±${(row.lateCI * 100).toFixed(2)}pp ` +
      `(seeds: ${row.seedRates.map((r) => (r * 100).toFixed(1) + '%').join(', ')})`,
    );
  }

  const bStar = selectBStar(rows);
  console.log('');
  console.log('# Calibration Summary');
  console.log('| Budget | Late mean | ±95% CI | Lower-CI | In band? |');
  console.log('|--------|-----------|---------|----------|----------|');
  for (const r of rows) {
    const lowerCI = r.lateMean - r.lateCI;
    const inBand =
      r.lateMean >= BAND_LOW && r.lateMean <= BAND_HIGH && lowerCI > 0
        ? 'YES'
        : 'no';
    console.log(
      `| ${r.budget} | ${(r.lateMean * 100).toFixed(2)}% | ±${(r.lateCI * 100).toFixed(2)}pp | ${(lowerCI * 100).toFixed(2)}pp | ${inBand} |`,
    );
  }
  console.log('');
  console.log(`B* = ${bStar.budget ?? 'NONE'} (${bStar.reason})`);

  // Write structured JSON
  writeFileSync(
    join(opts.output, 'calibration-result.json'),
    JSON.stringify({ rows, bStar, seeds, candidates: opts.budgets }, null, 2),
  );
}

// Only run main() when invoked as a script. When imported (by tests), skip.
const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
