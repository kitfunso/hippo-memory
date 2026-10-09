// The `hippo eval` verb; main() loads it lazily from the command table.

import * as path from 'path';
import * as fs from 'fs';
import type { MemoryEntry } from '../memory.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { loadConfig } from '../config.js';
import { getGlobalRoot } from '../shared.js';
import { runEval, bootstrapCorpus, compareSummaries, type EvalCase, type EvalSummary } from '../eval.js';
import { runFeatureEval, formatResult, resultToBaseline, detectRegressions, type EvalBaseline } from '../eval-suite.js';
import { PACKAGE_VERSION } from '../version.js';
import { printError } from './output.js';
import { requireInit, fmt, type CliFlags, type CommandContext } from './shared.js';

/** Runs `hippo eval`: --bootstrap writes a corpus, --suite runs the built-in feature eval, else it scores a corpus file. */
export async function cmdEval(
  hippoRoot: string,
  corpusPath: string | null,
  flags: CliFlags
): Promise<void> {
  const asJson = Boolean(flags['json']);
  const minMrr = flags['min-mrr'] !== undefined ? parseFloat(String(flags['min-mrr'])) : null;
  const comparePath = flags['compare'] ? String(flags['compare']) : null;

  // Suite mode doesn't need an initialized store
  if (!flags['suite']) requireInit(hippoRoot);

  const entries = flags['suite'] ? [] : loadAllEntries(hippoRoot);

  if (flags['bootstrap']) {
    writeBootstrapCorpus(entries, flags);
    return;
  }

  if (flags['suite']) {
    await runEvalSuite(hippoRoot, flags, asJson, minMrr);
    return;
  }

  const cases = readCorpus(corpusPath);
  const globalRoot = getGlobalRoot();
  const localBump = flags['equal-sources']
    ? 1.0
    : flags['local-bump'] !== undefined
      ? parseFloat(String(flags['local-bump']))
      : loadConfig(hippoRoot).search.localBump;

  const summary = await runEval(cases, entries, {
    hippoRoot,
    globalRoot,
    mmr: !flags['no-mmr'],
    mmrLambda: flags['mmr-lambda'] !== undefined ? parseFloat(String(flags['mmr-lambda'])) : undefined,
    embeddingWeight: flags['embedding-weight'] !== undefined ? parseFloat(String(flags['embedding-weight'])) : undefined,
    localBump,
  });

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printEvalSummary(summary, Boolean(flags['show-cases']));
  }

  if (minMrr !== null && summary.meanMrr < minMrr) {
    printError(`MRR ${fmt(summary.meanMrr, 4)} below threshold ${minMrr}`);
    process.exit(1);
  }

  if (comparePath) printEvalCompare(summary, comparePath, asJson);
}

/** Bootstrap mode: emit a synthetic corpus built from the store's own memories. */
function writeBootstrapCorpus(entries: MemoryEntry[], flags: CliFlags): void {
  const outPath = flags['out'] ? String(flags['out']) : null;
  const max = flags['max-cases'] !== undefined ? parseInt(String(flags['max-cases']), 10) : 50;
  const corpus = bootstrapCorpus(entries, max);
  const payload = JSON.stringify({ cases: corpus }, null, 2);
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, payload, 'utf8');
    console.log(`Wrote ${corpus.length} bootstrap cases to ${outPath}`);
  } else {
    console.log(payload);
  }
}

/** Suite mode: run the built-in feature eval (no corpus file needed, no init needed). */
async function runEvalSuite(hippoRoot: string, flags: CliFlags, asJson: boolean, minMrr: number | null): Promise<void> {
  const baselinePath = flags['baseline'] ? String(flags['baseline']) : path.join(hippoRoot, 'eval-baseline.json');
  let baseline: EvalBaseline | undefined;
  if (fs.existsSync(baselinePath)) {
    try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch {
      printError(`Warning: eval baseline ${baselinePath} is unreadable; running without it.`);
    }
  }

  const result = await runFeatureEval(PACKAGE_VERSION);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatResult(result, baseline));
  }

  if (flags['save-baseline']) {
    const newBaseline = resultToBaseline(result);
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(newBaseline, null, 2), 'utf8');
    console.log(`\nBaseline saved to ${baselinePath}`);
  }

  if (baseline) {
    const report = detectRegressions(baseline, result);
    if (report.verdict === 'REGRESSION' && minMrr === null) {
      process.exit(1);
    }
  }
}

/** Loads the corpus file, exiting with the usage line or the read error when there is none to score. */
function readCorpus(corpusPath: string | null): EvalCase[] {
  if (!corpusPath) {
    printError('Usage: hippo eval <corpus.json>  OR  hippo eval --suite [--save-baseline]  OR  hippo eval --bootstrap');
    process.exit(1);
  }

  if (!fs.existsSync(corpusPath)) {
    printError(`Corpus file not found: ${corpusPath}`);
    process.exit(1);
  }

  let cases: EvalCase[];
  try {
    const raw = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
    cases = Array.isArray(raw) ? raw : raw.cases;
    if (!Array.isArray(cases)) throw new Error('Corpus JSON must be an array or { cases: [...] }');
  } catch (err) {
    printError(`Failed to read corpus: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  return cases;
}

function printEvalSummary(summary: EvalSummary, showCases: boolean): void {
  console.log(`Eval: ${summary.cases.length} cases, ${summary.durationMs}ms`);
  console.log();
  console.log(`MRR:          ${fmt(summary.meanMrr, 4)}`);
  console.log(`Recall@5:     ${fmt(summary.meanRecallAt5, 4)}`);
  console.log(`Recall@10:    ${fmt(summary.meanRecallAt10, 4)}`);
  console.log(`NDCG@10:      ${fmt(summary.meanNdcgAt10, 4)}`);

  if (showCases) {
    console.log();
    console.log('Case details:');
    for (const c of summary.cases) {
      const exp = c.case.expectedIds.length;
      const expectedSet = new Set(c.case.expectedIds);
      const hitTop10 = c.returnedIds.slice(0, 10).filter((id) => expectedSet.has(id));
      const missed = c.case.expectedIds.filter((id) => !c.returnedIds.slice(0, 10).includes(id));
      console.log();
      console.log(`[${c.case.id}] R@10=${fmt(c.recallAt10, 2)}  MRR=${fmt(c.mrr, 2)}  expected=${exp}  hit=${hitTop10.length}`);
      console.log(`  query: ${c.case.query}`);
      console.log(`  top 3: ${c.returnedIds.slice(0, 3).join(', ') || '(none)'}`);
      if (missed.length > 0) {
        const shown = missed.slice(0, 4);
        const more = missed.length > shown.length ? ` +${missed.length - shown.length} more` : '';
        console.log(`  missed: ${shown.join(', ')}${more}`);
      }
    }
  }

  console.log();
  const failing = summary.cases.filter((c) => c.mrr === 0);
  if (failing.length > 0) {
    console.log(`${failing.length} case(s) returned zero relevant results:`);
    for (const f of failing.slice(0, 10)) {
      console.log(`  [${f.case.id}] "${f.case.query.slice(0, 60)}"`);
    }
    if (failing.length > 10) console.log(`  ...and ${failing.length - 10} more`);
  }
}

function printEvalCompare(summary: EvalSummary, comparePath: string, asJson: boolean): void {
  if (!fs.existsSync(comparePath)) {
    printError(`Baseline file not found: ${comparePath}`);
    process.exit(1);
  }
  let baseline: EvalSummary;
  try {
    baseline = JSON.parse(fs.readFileSync(comparePath, 'utf8'));
  } catch (err) {
    printError(`Failed to parse baseline: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  const cmp = compareSummaries(baseline, summary);

  if (asJson) {
    // The main JSON output already emitted; append comparison to stderr so
    // both can be captured independently.
    printError(JSON.stringify({ compare: cmp }, null, 2));
    return;
  }
  console.log();
  console.log('Compare vs baseline:');
  const sign = (d: number): string => (d >= 0 ? '+' : '') + fmt(d, 4);
  console.log(`  MRR:        ${sign(cmp.aggregate.mrr)}`);
  console.log(`  Recall@5:   ${sign(cmp.aggregate.recallAt5)}`);
  console.log(`  Recall@10:  ${sign(cmp.aggregate.recallAt10)}`);
  console.log(`  NDCG@10:    ${sign(cmp.aggregate.ndcgAt10)}`);
  console.log();
  console.log(`  improved: ${cmp.improved.length}   regressed: ${cmp.regressed.length}   unchanged: ${cmp.unchanged}`);
  if (cmp.onlyInBaseline.length > 0) console.log(`  only in baseline: ${cmp.onlyInBaseline.length}`);
  if (cmp.onlyInCurrent.length > 0) console.log(`  only in current:  ${cmp.onlyInCurrent.length}`);

  const showPerCase = cmp.improved.length + cmp.regressed.length > 0;
  if (showPerCase) {
    for (const d of cmp.improved.slice(0, 5)) {
      const delta = d.ndcgAfter - d.ndcgBefore;
      console.log(`  + [${d.id}] NDCG ${fmt(d.ndcgBefore, 2)} -> ${fmt(d.ndcgAfter, 2)} (+${fmt(delta, 3)})`);
    }
    for (const d of cmp.regressed.slice(0, 5)) {
      const delta = d.ndcgAfter - d.ndcgBefore;
      console.log(`  - [${d.id}] NDCG ${fmt(d.ndcgBefore, 2)} -> ${fmt(d.ndcgAfter, 2)} (${fmt(delta, 3)})`);
    }
  }
}

export async function handleEval({ hippoRoot, args, flags }: CommandContext): Promise<void> {
  const corpusPath = args[0] ? String(args[0]) : null;
  await cmdEval(hippoRoot, corpusPath, flags);
}
