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
// B* selection rule.
//
// P2-4 (v1.7.9): provenance for BAND_LOW / BAND_HIGH.
// Pre-registration anchor: v1.7.6 plan v2 (commit c670ac9, 2026-05-07) +
// calibrate.mjs (commit 9cd83de, 2026-05-07).
// Derivation: ±10pp around the v0.11.0 informal headline of 14% late-phase
// trap-rate. The headline magnitude was RETRACTED v1.7.9 (see CHANGELOG and
// docs/RETRACTION.md) based on cumulative evidence from v1.7.5/6/7 (every
// C2 hippo-base late mean returned 0% across every seed across three
// pre-registered variants). The band itself is preserved here for historical
// reproducibility of the v1.7.6 calibration sweep. Future calibration should
// use the v1.7.7 N=4 lattice gate ([0.05, 0.50] AND >=3 distinct seeds
// non-zero) — see analyze-v1.7.7.mjs for the current sanity-gate shape.
// NOTE: v1.7.6 did not have a separate prereg file; pre-reg lives in plan v2
// + calibrate.mjs commits as cited above (the prior reference to
// docs/evals/2026-05-07-v1.7.6-goal-stack-eval-prereg.md was a stale path
// surfaced and corrected during the v1.7.8 audit).
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
  // POST-AUDIT P1-3 (v1.7.8): only include "(not starved)" in the reason
  // string when ANY candidate carries the `starved` flag. The starvation
  // guard was deferred in v1.7.6 (broken extraction dropped); referencing
  // it inertly in error messages overstates the rule.
  const anyStarved = candidates.some((c) => c.starved === true);
  const starvedClause = anyStarved ? ' AND (not starved)' : '';

  const sorted = [...candidates].sort((a, b) => b.budget - a.budget);
  for (const c of sorted) {
    if (c.starved === true) continue; // starvation exclusion (defensive; flag deferred to v1.7.8+)
    const lowerCI = c.lateMean - c.lateCI;
    if (
      c.lateMean >= BAND_LOW &&
      c.lateMean <= BAND_HIGH &&
      lowerCI > 0
    ) {
      return {
        budget: c.budget,
        reason: `largest budget in band [${BAND_LOW}, ${BAND_HIGH}] with lower-CI ${lowerCI.toFixed(4)} > 0${anyStarved ? ' (not starved)' : ''}`,
      };
    }
  }
  return {
    budget: null,
    reason: `No candidate satisfies (mean ∈ [${BAND_LOW}, ${BAND_HIGH}]) AND (lower-CI > 0)${starvedClause}.`,
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
    // POST-AUDIT P1-6 (v1.7.8): defensive throw with context if the JSON shape
    // is unexpected (e.g., wrong adapter ran, schema drift). Without this,
    // `j.conditions[condName]` would TypeError with no hint of which file.
    if (!j.conditions || Object.keys(j.conditions).length === 0) {
      throw new Error(
        `runOneBudget: ${seedDir}/${files[files.length - 1]} has no conditions. ` +
        `Expected at least one adapter result; got ${JSON.stringify(j.conditions)}.`,
      );
    }
    const condName = Object.keys(j.conditions)[0];
    // Single-seed path -- read directly from `phases.late`.
    const lateRate = j.conditions[condName].phases.late;
    if (typeof lateRate !== 'number') {
      throw new Error(
        `runOneBudget: phases.late not numeric for ${seedDir} (got ${typeof lateRate}). ` +
        `Schema may have changed; verify run.mjs::buildOutput output shape.`,
      );
    }
    seedRates.push(lateRate);
  }
  // Starvation guard (post-review P1-4) was originally intended to flag candidates
  // where mean per-seed recall surface < 1. The implementation read
  // `j.conditions[condName].results[]`, but `buildOutput` (run.mjs:393) does NOT
  // serialize the per-task `results` array in single-seed JSON — it only writes
  // `overall_trap_hit_rate`, `phases`, `learns`, `improvement_pct`, `hook_failures`.
  // The 2026-05-09 v1.7.6 calibration confirmed this: false-positive `starved=true`
  // on every candidate. The bug was masked because `lateMean=0%` was the
  // load-bearing rejection signal across all 5 budgets (workload floor effect,
  // not budget-tunable).
  //
  // Decision: drop the broken extraction in v1.7.6. Tracked for v1.7.7+ as
  // "expose per-task results in single-seed JSON" + "re-enable starvation guard".
  // selectBStar still respects an optional `starved` field defensively.
  return {
    budget,
    seedRates,
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
