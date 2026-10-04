#!/usr/bin/env node
/**
 * Paired agent A/B analyzer (ROADMAP Part IX, TE5).
 *
 * Reads run records from the task-sequence eval and reports, for every arm
 * against the control arm (`no-memory` by default), with bootstrap CIs:
 *   - dollars (or uncached-equivalent tokens) per resolved task, the headline;
 *   - resolve-rate difference, clustered by repository;
 *   - pass@1 and pass^k;
 *   - work avoided: turns, file reads, tool calls, repeated errors per task.
 *
 * Protocol and pre-registered thresholds:
 * docs/evals/2026-09-23-te5-token-ab-preregistration.md.
 *
 * Input: JSONL, one record per (task, arm, seed):
 *   { taskId, cluster, arm, seed, resolved,
 *     usage: { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens },
 *     turns?, fileReads?, toolCalls?, repeatedErrors? }
 * usage comes from the provider's usage fields summed over the task. A
 * record whose usage is missing is rejected, never zero-filled. Records from
 * scripts/token-eval/ab-run.mjs also carry `scored` (false for the first
 * task of a sequence) and `invalid` (a reason, e.g. 'no-result' or 'leak');
 * both are excluded from scoring and counted in the output.
 *
 * Prices: --prices FILE with {inputPerMTok, cacheWritePerMTok,
 * cacheReadPerMTok, outputPerMTok} from the provider's current price page.
 * Without it, cost is input in uncached-equivalent tokens plus output tokens
 * weighted by --output-ratio (default 5).
 *
 * Run: npm run build && node scripts/token-eval/ab-analyze.mjs --runs FILE
 *      [--prices FILE] [--control no-memory] [--k 3] [--out FILE]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  priceUsage,
  uncachedEquivalentInput,
  costPerResolvedDelta,
  clusteredPairedBootstrap,
  passAtK,
  passHatK,
} from '../../dist/eval-stats.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const WORK_FIELDS = ['turns', 'fileReads', 'toolCalls', 'repeatedErrors'];
const USAGE_FIELDS = ['inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'outputTokens'];

/** JSON string check without `typeof` (anti-slop rule). */
function isString(v) {
  return v !== undefined && v !== null && v.constructor === String;
}

/** Parse and validate JSONL run records. Throws on the first bad record. */
export function parseRuns(text) {
  const records = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const r = JSON.parse(line);
    const where = `line ${i + 1}`;
    for (const f of ['taskId', 'cluster', 'arm']) {
      if (!isString(r[f]) || !r[f]) throw new Error(`${where}: ${f} must be a non-empty string`);
    }
    if (!Number.isInteger(r.seed)) throw new Error(`${where}: seed must be an integer`);
    if (r.resolved !== true && r.resolved !== false) throw new Error(`${where}: resolved must be true or false`);
    // Unscored (first task of a sequence) and invalid runs (no result,
    // memory leak of the gold patch) are kept so analyze() can report them,
    // but they are never scored.
    if (r.scored === false || r.invalid) {
      records.push(r);
      return;
    }
    if (!r.usage) throw new Error(`${where}: usage is required (never zero-filled)`);
    for (const f of USAGE_FIELDS) {
      if (!Number.isFinite(r.usage[f]) || r.usage[f] < 0) throw new Error(`${where}: usage.${f} must be a non-negative number`);
    }
    records.push(r);
  });
  return records;
}

/** Cost of one record: dollars with prices, else uncached-equivalent tokens.
 * @param {any} r
 * @param {import('../../src/eval-stats.js').Prices | null} prices
 * @param {number} [outputRatio] */
export function recordCost(r, prices, outputRatio = 5) {
  if (prices) return priceUsage(r.usage, prices);
  return uncachedEquivalentInput(r.usage) + r.usage.outputTokens * outputRatio;
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

/**
 * Compare every arm with the control arm. Seeds are averaged per task for
 * cost and work metrics; a task counts as resolved in an arm when the
 * majority of its seeds resolved it (ties count as unresolved). Only tasks
 * present in both arms are compared; the rest are listed as unpaired.
 * @param {any[]} allRecords
 * @param {{prices?: import('../../src/eval-stats.js').Prices | null, control?: string, k?: number, outputRatio?: number, seed?: number}} [options]
 */
export function analyze(allRecords, { prices = null, control = 'no-memory', k = 3, outputRatio = 5, seed = 1 } = {}) {
  const records = allRecords.filter((r) => r.scored !== false && !r.invalid);
  const invalidByReason = {};
  for (const r of allRecords) if (r.invalid) invalidByReason[r.invalid] = (invalidByReason[r.invalid] ?? 0) + 1;
  const excluded = { unscored: allRecords.filter((r) => r.scored === false && !r.invalid).length, invalid: invalidByReason };
  const arms = [...new Set(records.map((r) => r.arm))].sort();
  if (!arms.includes(control)) throw new Error(`control arm "${control}" has no records`);
  const byArmTask = new Map();
  for (const r of records) {
    const key = `${r.arm}\u0000${r.taskId}`;
    if (!byArmTask.has(key)) byArmTask.set(key, []);
    byArmTask.get(key).push(r);
  }
  const taskIds = (arm) => [...new Set(records.filter((r) => r.arm === arm).map((r) => r.taskId))].sort();
  const taskSummary = (arm, taskId) => {
    const runs = [...byArmTask.get(`${arm}\u0000${taskId}`)].sort((a, b) => a.seed - b.seed);
    const work = {};
    for (const f of WORK_FIELDS) {
      const vals = runs.map((r) => r[f]).filter((v) => Number.isFinite(v));
      work[f] = vals.length === runs.length ? mean(vals) : null;
    }
    return {
      cluster: runs[0].cluster,
      cost: mean(runs.map((r) => recordCost(r, prices, outputRatio))),
      resolved: runs.filter((r) => r.resolved).length * 2 > runs.length,
      runs: runs.map((r) => r.resolved),
      work,
    };
  };

  const controlTasks = new Set(taskIds(control));
  const comparisons = [];
  for (const arm of arms) {
    if (arm === control) continue;
    const shared = taskIds(arm).filter((t) => controlTasks.has(t));
    const c = shared.map((t) => taskSummary(control, t));
    const t = shared.map((id) => taskSummary(arm, id));
    const resolveDiffs = new Map();
    shared.forEach((_, i) => {
      const cl = c[i].cluster;
      if (!resolveDiffs.has(cl)) resolveDiffs.set(cl, []);
      resolveDiffs.get(cl).push((t[i].resolved ? 1 : 0) - (c[i].resolved ? 1 : 0));
    });
    /** @type {Record<string, ReturnType<typeof clusteredPairedBootstrap> | null>} */
    const work = {};
    for (const f of WORK_FIELDS) {
      const diffs = new Map();
      let complete = true;
      shared.forEach((_, i) => {
        if (c[i].work[f] === null || t[i].work[f] === null) { complete = false; return; }
        const cl = c[i].cluster;
        if (!diffs.has(cl)) diffs.set(cl, []);
        diffs.get(cl).push(t[i].work[f] - c[i].work[f]);
      });
      work[f] = complete && shared.length > 0 ? clusteredPairedBootstrap(diffs, { seed }) : null;
    }
    comparisons.push({
      arm,
      control,
      tasks: shared.length,
      unpaired: taskIds(arm).filter((x) => !controlTasks.has(x)),
      costPerResolved: costPerResolvedDelta(c, t, { seed }),
      resolveRate: { control: mean(c.map((x) => (x.resolved ? 1 : 0))), arm: mean(t.map((x) => (x.resolved ? 1 : 0))), delta: clusteredPairedBootstrap(resolveDiffs, { seed }) },
      passAt1: { control: passAtK(c.map((x) => x.runs), 1), arm: passAtK(t.map((x) => x.runs), 1) },
      passHatK: { k, control: passHatK(c.map((x) => x.runs), k), arm: passHatK(t.map((x) => x.runs), k) },
      work,
    });
  }
  return { costUnit: prices ? 'usd' : 'uncached-equivalent tokens (output weighted)', arms, excluded, comparisons };
}

function main() {
  const flag = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
  };
  const runsFile = flag('--runs', null);
  if (!runsFile) {
    console.error('Usage: node scripts/token-eval/ab-analyze.mjs --runs FILE [--prices FILE] [--control ARM] [--k 3] [--out FILE]');
    process.exit(1);
  }
  const pricesFile = flag('--prices', null);
  const prices = pricesFile ? JSON.parse(fs.readFileSync(pricesFile, 'utf8')) : null;
  const result = analyze(parseRuns(fs.readFileSync(runsFile, 'utf8')), {
    prices,
    control: flag('--control', 'no-memory'),
    k: Number(flag('--k', '3')),
    outputRatio: Number(flag('--output-ratio', '5')),
  });
  const outFile = flag('--out', null);
  if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
  const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : String(x));
  const p = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
  console.log(`Cost unit: ${result.costUnit}`);
  const inv = Object.entries(result.excluded.invalid).map(([k, v]) => `${v} ${k}`).join(', ');
  console.log(`Excluded: ${result.excluded.unscored} unscored first tasks${inv ? `; invalid runs: ${inv}` : ''}\n`);
  for (const c of result.comparisons) {
    const cpr = c.costPerResolved;
    console.log(`${c.arm} vs ${c.control} (${c.tasks} paired tasks${c.unpaired.length ? `, ${c.unpaired.length} unpaired` : ''})`);
    console.log(`  cost per resolved task: ${f(cpr.control)} -> ${f(cpr.treatment)}  (${p(cpr.relative.estimate)} [${p(cpr.relative.low)}, ${p(cpr.relative.high)}])`);
    console.log(`  resolve rate: ${p(c.resolveRate.control)} -> ${p(c.resolveRate.arm)}  (${(c.resolveRate.delta.estimate * 100).toFixed(1)}pp [${(c.resolveRate.delta.low * 100).toFixed(1)}, ${(c.resolveRate.delta.high * 100).toFixed(1)}])`);
    console.log(`  pass@1 ${p(c.passAt1.control)} -> ${p(c.passAt1.arm)}; pass^${c.passHatK.k} ${p(c.passHatK.control)} -> ${p(c.passHatK.arm)}`);
    for (const [name, est] of Object.entries(c.work)) {
      if (est) console.log(`  ${name} per task: ${est.estimate >= 0 ? '+' : ''}${est.estimate.toFixed(2)} [${est.low.toFixed(2)}, ${est.high.toFixed(2)}]`);
    }
    console.log('');
  }
  if (outFile) console.log(`Wrote ${path.relative(REPO, path.resolve(outFile))}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
