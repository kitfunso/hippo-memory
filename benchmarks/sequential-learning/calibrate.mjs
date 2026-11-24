import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mean, ciHalfWidth95 } from './aggregate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Human-readable type name for an error message, without `typeof`.
 * @param {unknown} value
 * @returns {string}
 */
function describeType(value) {
  return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
}

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
  const anyStarved = candidates.some((c) => c.starved === true);
  const starvedClause = anyStarved ? ' AND (not starved)' : '';

  const sorted = [...candidates].sort((a, b) => b.budget - a.budget);
  for (const c of sorted) {
    if (c.starved === true) continue;
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
  return Array.from({ length: n }, (_, i) =>
    (Math.imul(0x9E3779B9, (1000 + 10000 + i) >>> 0)) >>> 0,
  );
}

function runOneBudget(budget, seeds, outputBase) {
  const outDir = join(outputBase, `budget-${budget}`);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const seedRates = [];
  for (const seed of seeds) {
    const seedDir = join(outDir, `seed-${seed}`);
    if (!existsSync(seedDir)) mkdirSync(seedDir, { recursive: true });
    execSync(
      `node "${join(__dirname, 'run.mjs')}" --adapter hippo --seed ${seed} --budget ${budget} --output "${seedDir}"`,
      { stdio: 'inherit' },
    );
    const files = readdirSync(seedDir).filter((f) => f.endsWith('.json'));
    if (files.length === 0) throw new Error(`No JSON output in ${seedDir}`);
    files.sort();
    const j = JSON.parse(readFileSync(join(seedDir, files[files.length - 1]), 'utf-8'));
    if (!j.conditions || Object.keys(j.conditions).length === 0) {
      throw new Error(
        `runOneBudget: ${seedDir}/${files[files.length - 1]} has no conditions. ` +
        `Expected at least one adapter result; got ${JSON.stringify(j.conditions)}.`,
      );
    }
    const condName = Object.keys(j.conditions)[0];
    const lateRate = j.conditions[condName].phases.late;
    if (Object.prototype.toString.call(lateRate) !== '[object Number]') {
      throw new Error(
        `runOneBudget: phases.late not numeric for ${seedDir} (got ${describeType(lateRate)}). ` +
        `Schema may have changed; verify run.mjs::buildOutput output shape.`,
      );
    }
    seedRates.push(lateRate);
  }
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

  writeFileSync(
    join(opts.output, 'calibration-result.json'),
    JSON.stringify({ rows, bStar, seeds, candidates: opts.budgets }, null, 2),
  );
}

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
