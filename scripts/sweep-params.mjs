#!/usr/bin/env node
/**
 * Sweep runtime recall parameters through the eval harness and report
 * which combinations win on which metrics. Produces a ranked table plus
 * a Pareto frontier so you can see tradeoffs instead of just one "winner".
 *
 * Sweeps only parameters that are tunable at recall time:
 *   - MMR lambda
 *   - Embedding weight (BM25 vs cosine blend)
 *   - Local bump (local-over-global source priority)
 *
 * Half-life / retrieval-boost / error-multiplier are per-memory and baked
 * into the store, so a fair sweep would need store regeneration -- out of
 * scope for a recall-time tuning script.
 *
 * Usage:
 *   node scripts/sweep-params.mjs [corpus.json] [--out <path>]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runEval } from '../dist/eval.js';
import { isInitialized } from '../dist/store.js';
import { loadConfig } from '../dist/config.js';

const CORPUS_PATH = process.argv.find((a) => a.endsWith('.json') && !a.startsWith('--'))
  ?? path.join(process.cwd(), 'evals', 'real-corpus.json');
const OUT_PATH = flagValue('--out', null);

function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

if (!fs.existsSync(CORPUS_PATH)) {
  console.error(`Corpus not found: ${CORPUS_PATH}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
const cases = Array.isArray(raw) ? raw : raw.cases;

const hippoRoot = path.join(process.cwd(), '.hippo');
const globalRoot = path.join(os.homedir(), '.hippo');
if (!isInitialized(hippoRoot)) {
  console.error(`No .hippo in ${process.cwd()}`);
  process.exit(1);
}
// searchBothHybrid inside runEval loads its own per-query candidate set from
// FTS5; we don't need to preload entries here.
const defaults = loadConfig(hippoRoot);

// Parameter grids. Kept modest because each combo runs all cases through
// searchBothHybrid (local + global DB open per query). Pass --quick for a
// 2x2x2 smoke sweep.
const QUICK = process.argv.includes('--quick');
const LAMBDA_GRID = QUICK ? [0.5, 0.9] : [0.5, 0.7, 0.9, 1.0];
const EMB_WEIGHT_GRID = QUICK ? [0.5, 0.8] : [0.4, 0.6, 0.8];
const LOCAL_BUMP_GRID = QUICK ? [1.0, 1.2] : [1.0, 1.2];
const MMR_TOGGLE = QUICK ? [true] : [true, false];

const combos = [];
for (const mmr of MMR_TOGGLE) {
  for (const lambda of LAMBDA_GRID) {
    // No need to sweep lambda when MMR is off
    if (!mmr && lambda !== 0.7) continue;
    for (const emb of EMB_WEIGHT_GRID) {
      for (const bump of LOCAL_BUMP_GRID) {
        combos.push({ mmr, lambda, emb, bump });
      }
    }
  }
}

// Mark which combo is the current config so we can highlight it in output.
const defaultCombo = {
  mmr: defaults.mmr.enabled,
  lambda: defaults.mmr.lambda,
  emb: defaults.embeddings.hybridWeight,
  bump: defaults.search.localBump,
};

console.error(`Sweeping ${combos.length} combinations on ${cases.length} cases...`);

// Stream partial results to JSONL so a killed run still leaves useful data.
const streamPath = OUT_PATH ? OUT_PATH.replace(/\.md$/, '.jsonl') : path.join(process.cwd(), 'evals', 'sweep-partial.jsonl');
fs.mkdirSync(path.dirname(streamPath), { recursive: true });
fs.writeFileSync(streamPath, '');

const rows = [];
for (let i = 0; i < combos.length; i++) {
  const c = combos[i];
  let summary;
  let attempts = 0;
  while (true) {
    try {
      summary = await runEval(cases, [], {
        hippoRoot,
        globalRoot,
        mmr: c.mmr,
        mmrLambda: c.lambda,
        embeddingWeight: c.emb,
        localBump: c.bump,
      });
      break;
    } catch (err) {
      attempts++;
      if (attempts >= 3 || !String(err).includes('locked')) throw err;
      await new Promise((r) => setTimeout(r, 200 * attempts));
    }
  }
  const row = {
    ...c,
    mrr: summary.meanMrr,
    r5: summary.meanRecallAt5,
    r10: summary.meanRecallAt10,
    ndcg: summary.meanNdcgAt10,
    isDefault: c.mmr === defaultCombo.mmr
      && Math.abs(c.lambda - defaultCombo.lambda) < 1e-6
      && Math.abs(c.emb - defaultCombo.emb) < 1e-6
      && Math.abs(c.bump - defaultCombo.bump) < 1e-6,
  };
  rows.push(row);
  fs.appendFileSync(streamPath, JSON.stringify(row) + '\n');
  console.error(`  ${i + 1}/${combos.length}  MRR=${summary.meanMrr.toFixed(3)} NDCG@10=${summary.meanNdcgAt10.toFixed(3)}`);
}

// Sort by NDCG desc, break ties by R@10 desc.
rows.sort((a, b) => (b.ndcg - a.ndcg) || (b.r10 - a.r10));

// Pareto frontier: row is Pareto-optimal if no other row has (>=) on all
// four metrics AND (>) on at least one.
function dominates(x, y) {
  const ge = x.mrr >= y.mrr && x.r5 >= y.r5 && x.r10 >= y.r10 && x.ndcg >= y.ndcg;
  const gt = x.mrr > y.mrr || x.r5 > y.r5 || x.r10 > y.r10 || x.ndcg > y.ndcg;
  return ge && gt;
}
const pareto = rows.filter((r) => !rows.some((o) => o !== r && dominates(o, r)));

// --- Output ---
function pct(n) { return (n * 100).toFixed(1) + '%'; }
function line(r, flag = '') {
  const mmrLabel = r.mmr ? `MMR l=${r.lambda.toFixed(1)}` : 'no-MMR        ';
  const emb = `emb=${r.emb.toFixed(1)}`;
  const bump = `bump=${r.bump.toFixed(1)}`;
  return `  ${flag.padEnd(9)} ${mmrLabel.padEnd(12)} ${emb.padEnd(8)} ${bump.padEnd(9)} MRR=${r.mrr.toFixed(3)}  R@5=${pct(r.r5).padEnd(6)}  R@10=${pct(r.r10).padEnd(6)}  NDCG=${r.ndcg.toFixed(3)}`;
}

const md = [];
md.push(`# Parameter sweep results`);
md.push('');
md.push(`Corpus: \`${path.basename(CORPUS_PATH)}\` (${cases.length} cases, local + global in scope)`);
md.push(`Sweep space: ${combos.length} combinations across lambda x emb-weight x local-bump x mmr-toggle`);
md.push('');
md.push('## Top 15 by NDCG@10');
md.push('');
md.push('| Rank | Config | MRR | R@5 | R@10 | NDCG@10 |');
md.push('|---|---|---|---|---|---|');
rows.slice(0, 15).forEach((r, i) => {
  const cfg = r.mmr ? `lambda=${r.lambda} emb=${r.emb} bump=${r.bump}` : `no-MMR emb=${r.emb} bump=${r.bump}`;
  const flag = r.isDefault ? ' **(default)**' : '';
  md.push(`| ${i + 1} | ${cfg}${flag} | ${r.mrr.toFixed(3)} | ${pct(r.r5)} | ${pct(r.r10)} | ${r.ndcg.toFixed(3)} |`);
});
md.push('');
md.push(`## Pareto frontier (${pareto.length} configs)`);
md.push('');
md.push('These are non-dominated across all four metrics. Any improvement on one metric costs something on another.');
md.push('');
md.push('| Config | MRR | R@5 | R@10 | NDCG@10 |');
md.push('|---|---|---|---|---|');
pareto.sort((a, b) => b.ndcg - a.ndcg).forEach((r) => {
  const cfg = r.mmr ? `lambda=${r.lambda} emb=${r.emb} bump=${r.bump}` : `no-MMR emb=${r.emb} bump=${r.bump}`;
  const flag = r.isDefault ? ' **(default)**' : '';
  md.push(`| ${cfg}${flag} | ${r.mrr.toFixed(3)} | ${pct(r.r5)} | ${pct(r.r10)} | ${r.ndcg.toFixed(3)} |`);
});
md.push('');
md.push(`## Default vs best`);
md.push('');
const defaultRow = rows.find((r) => r.isDefault);
const best = rows[0];
if (defaultRow && best && defaultRow !== best) {
  md.push(`Default ranks #${rows.indexOf(defaultRow) + 1} of ${rows.length}.`);
  md.push('');
  md.push('| | MRR | R@5 | R@10 | NDCG@10 |');
  md.push('|---|---|---|---|---|');
  md.push(`| default | ${defaultRow.mrr.toFixed(3)} | ${pct(defaultRow.r5)} | ${pct(defaultRow.r10)} | ${defaultRow.ndcg.toFixed(3)} |`);
  md.push(`| best    | ${best.mrr.toFixed(3)} | ${pct(best.r5)} | ${pct(best.r10)} | ${best.ndcg.toFixed(3)} |`);
  md.push(`| delta   | ${(best.mrr - defaultRow.mrr >= 0 ? '+' : '') + (best.mrr - defaultRow.mrr).toFixed(3)} | ${(best.r5 - defaultRow.r5 >= 0 ? '+' : '') + ((best.r5 - defaultRow.r5) * 100).toFixed(1)}pp | ${(best.r10 - defaultRow.r10 >= 0 ? '+' : '') + ((best.r10 - defaultRow.r10) * 100).toFixed(1)}pp | ${(best.ndcg - defaultRow.ndcg >= 0 ? '+' : '') + (best.ndcg - defaultRow.ndcg).toFixed(3)} |`);
} else if (defaultRow === best) {
  md.push('Defaults are the single best config on this corpus.');
}

const output = md.join('\n');
if (OUT_PATH) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, output, 'utf8');
  console.error(`Wrote report to ${OUT_PATH}`);
} else {
  console.log(output);
}

// Terse stderr summary so the script is useful even without --out
console.error('');
console.error('=== Quick summary ===');
console.error(line(rows[0], '[best]'));
if (defaultRow && defaultRow !== best) {
  console.error(line(defaultRow, '[default]'));
}
