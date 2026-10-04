#!/usr/bin/env node
/**
 * Token-at-accuracy curve (ROADMAP Part IX, TE3).
 *
 * Question: how many tokens of memory does an agent need to see the evidence
 * for an answer, with hippo versus simpler strategies? Retrieval recall at a
 * fixed 4000-token budget is saturated on LongMemEval per-haystack, so this
 * sweeps the budget and reports evidence recall against the tokens actually
 * injected, plus the minimum tokens needed per question.
 *
 * Per question it builds a hermetic store holding that question's haystack
 * (one memory per session, full text, no truncation) and compares:
 *   hippo         hybridSearch (BM25, plus cosine when embeddings exist) packed
 *                 to the budget with hippo's own greedy packer (minResults 1,
 *                 the product default, so tokens can exceed a tiny budget and
 *                 are reported as actually injected)
 *   recency       the newest sessions that fit the budget (a window: stops at
 *                 the first session that does not fit)
 *   full-context  every session (the "stuff everything in" baseline)
 *   no-memory     nothing
 *
 * Scoring: evidence recall = the packed memories include at least one of the
 * question's answer_session_ids. It measures whether the agent could see the
 * evidence, not whether a model answers correctly.
 *
 * Data: any LongMemEval-format JSON (longmemeval_s_cleaned.json,
 * longmemeval_oracle.json from the LongMemEval release). Fields may be JSON
 * arrays or Python-literal strings (the bundled synthetic_smoke.json); the
 * latter are converted with python3.
 *
 * Deferred: an LLMLingua-2 compression arm (needs its Python package and
 * model); add it as another arm when run where those are available.
 *
 * Run: npm run build && node scripts/token-eval/budget-curve.mjs
 *      [--data FILE] [--limit N] [--budgets 250,500,1000,2000,4000,8000] [--out FILE]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createMemory, Layer } from '../../dist/memory.js';
import { initStore } from '../../dist/store/open.js';
import { writeEntry } from '../../dist/store/entry-writes.js';
import { loadAllEntries } from '../../dist/store/entry-reads.js';
import { hybridSearch } from '../../dist/search/hybrid.js';
import { isEmbeddingAvailable } from '../../dist/local-embedding.js';
import { estimateTokens } from '../../dist/token-ledger.js';
import { pairedBootstrap } from '../../dist/eval-stats.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

export const DEFAULT_BUDGETS = [250, 500, 1000, 2000, 4000, 8000];
export const ARMS = ['hippo', 'recency', 'full-context', 'no-memory'];

/** Load LongMemEval-format questions, converting Python-literal string fields. */
export function loadQuestions(file) {
  let data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const needsLiteral = data.some((q) => q.haystack_sessions !== undefined && q.haystack_sessions !== null && q.haystack_sessions.constructor === String);
  if (needsLiteral) {
    const py = 'import json,ast,sys\nd=json.load(open(sys.argv[1]))\n'
      + 'for q in d:\n  for k in ("haystack_sessions","haystack_session_ids","haystack_dates","answer_session_ids"):\n'
      + '    v=q.get(k)\n    if isinstance(v,str): q[k]=ast.literal_eval(v)\n'
      + 'json.dump(d,sys.stdout)';
    data = JSON.parse(execFileSync('python3', ['-c', py, file], { encoding: 'utf8', maxBuffer: 1 << 30 }));
  }
  return data;
}

function sessionText(date, sessionId, turns) {
  const body = turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n');
  return `[Date: ${date || 'unknown'}]\n[Session: ${sessionId}]\n\n${body}`;
}

// Recency is a window: the newest sessions until the next one does not fit,
// like "keep the last N messages". It does not skip ahead to older, smaller
// sessions, which would make it a size-based picker rather than recency.
function packRecent(items, budget) {
  const out = [];
  let used = 0;
  for (const it of items) {
    if (used + it.tokens > budget) break;
    out.push(it);
    used += it.tokens;
  }
  return out;
}

/** Evaluate one question across every arm and budget. */
export async function evaluateQuestion(q, budgets) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-budget-curve-'));
  const hippoRoot = path.join(workDir, '.hippo');
  try {
    initStore(hippoRoot);
    const sessions = q.haystack_sessions.map((turns, i) => {
      const sid = q.haystack_session_ids[i];
      const date = q.haystack_dates ? q.haystack_dates[i] : '';
      const text = sessionText(date, sid, turns);
      return { sid, date, text, tokens: estimateTokens(text) };
    });
    for (const s of sessions) {
      writeEntry(hippoRoot, createMemory(s.text, { layer: Layer.Episodic, tags: [`session:${s.sid}`], source: 'budget-curve' }));
    }
    const entries = loadAllEntries(hippoRoot);
    const evidence = new Set(q.answer_session_ids);
    const sidOf = (entry) => {
      const tag = entry.tags.find((t) => t.startsWith('session:'));
      return tag ? tag.slice('session:'.length) : null;
    };
    const hit = (sids) => sids.some((s) => evidence.has(s));
    const byNewest = [...sessions].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const fullTokens = sessions.reduce((s, x) => s + x.tokens, 0);

    /** @type {Record<number, Record<'hippo' | 'recency', {hit: boolean, tokens: number}>>} */
    const perBudget = {};
    for (const budget of budgets) {
      const results = await hybridSearch(q.question, entries, { budget, hippoRoot });
      const hippoSids = results.map((r) => sidOf(r.entry));
      const recency = packRecent(byNewest, budget);
      perBudget[budget] = {
        hippo: { hit: hit(hippoSids), tokens: results.reduce((s, r) => s + r.tokens, 0) },
        recency: { hit: hit(recency.map((s) => s.sid)), tokens: recency.reduce((s, x) => s + x.tokens, 0) },
      };
    }
    const minBudget = (arm) => {
      const b = budgets.find((x) => perBudget[x][arm].hit);
      return b === undefined ? null : { budget: b, tokens: perBudget[b][arm].tokens };
    };
    return {
      questionId: q.question_id,
      questionType: q.question_type,
      sessions: sessions.length,
      fullContextTokens: fullTokens,
      fullContextHit: hit(sessions.map((s) => s.sid)),
      perBudget,
      minToAnswer: { hippo: minBudget('hippo'), recency: minBudget('recency') },
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Aggregate per-question results into the curve. */
export function summarize(perQuestion, budgets) {
  const n = perQuestion.length;
  const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
  const curve = budgets.map((budget) => {
    const hippoHits = perQuestion.map((q) => (q.perBudget[budget].hippo.hit ? 1 : 0));
    const recencyHits = perQuestion.map((q) => (q.perBudget[budget].recency.hit ? 1 : 0));
    return {
      budget,
      hippo: { evidenceRecall: mean(hippoHits), meanTokens: Math.round(mean(perQuestion.map((q) => q.perBudget[budget].hippo.tokens))) },
      recency: { evidenceRecall: mean(recencyHits), meanTokens: Math.round(mean(perQuestion.map((q) => q.perBudget[budget].recency.tokens))) },
      hippoMinusRecency: pairedBootstrap(hippoHits.map((h, i) => h - recencyHits[i]), { seed: budget }),
    };
  });
  const fullTokens = perQuestion.map((q) => q.fullContextTokens);
  const hippoMin = perQuestion.map((q) => q.minToAnswer.hippo?.tokens).filter((x) => x !== undefined);
  const recencyMin = perQuestion.map((q) => q.minToAnswer.recency?.tokens).filter((x) => x !== undefined);
  return {
    questions: n,
    curve,
    fullContext: { evidenceRecall: mean(perQuestion.map((q) => (q.fullContextHit ? 1 : 0))), meanTokens: Math.round(mean(fullTokens)) },
    noMemory: { evidenceRecall: 0, meanTokens: 0 },
    minTokensToAnswer: {
      hippo: { answered: hippoMin.length, median: median(hippoMin) },
      recency: { answered: recencyMin.length, median: median(recencyMin) },
      fullContextMedian: median(fullTokens),
    },
  };
}

async function main() {
  const flag = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
  };
  const defaultData = [
    path.join(REPO, 'benchmarks', 'longmemeval', 'data', 'longmemeval_s_cleaned.json'),
    path.join(REPO, 'benchmarks', 'longmemeval', 'data', 'synthetic_smoke.json'),
  ].find((p) => fs.existsSync(p));
  const dataFile = flag('--data', defaultData);
  const limit = Number(flag('--limit', '0'));
  const budgets = flag('--budgets', DEFAULT_BUDGETS.join(',')).split(',').map(Number).filter((x) => x > 0).sort((a, b) => a - b);
  const outFile = flag('--out', path.join(REPO, 'benchmarks', 'token-eval', 'budget-curve-results.json'));
  if (!dataFile) {
    console.error('No data file. Pass --data <LongMemEval JSON>.');
    process.exit(1);
  }
  let questions = loadQuestions(dataFile);
  if (limit > 0) questions = questions.slice(0, limit);
  const t0 = Date.now();
  const perQuestion = [];
  for (const q of questions) perQuestion.push(await evaluateQuestion(q, budgets));
  const summary = summarize(perQuestion, budgets);
  const out = {
    meta: {
      harness: 'scripts/token-eval/budget-curve.mjs',
      generatedAt: new Date().toISOString(),
      data: path.relative(REPO, dataFile),
      embeddings: isEmbeddingAvailable(),
      tokenEstimate: 'characters / 4',
      scoring: 'evidence recall: any answer_session_id among the packed memories',
    },
    summary,
    perQuestion,
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  console.log(`Token-at-accuracy curve: ${summary.questions} questions from ${out.meta.data} (${((Date.now() - t0) / 1000).toFixed(1)}s, embeddings ${out.meta.embeddings ? 'on' : 'off'})\n`);
  console.log('budget   hippo recall / tokens   recency recall / tokens   hippo-recency [95% CI]');
  for (const row of summary.curve) {
    const d = row.hippoMinusRecency;
    console.log(`${String(row.budget).padStart(6)}   ${pct(row.hippo.evidenceRecall).padStart(5)} / ${String(row.hippo.meanTokens).padStart(6)}        `
      + `${pct(row.recency.evidenceRecall).padStart(5)} / ${String(row.recency.meanTokens).padStart(6)}          `
      + `${(d.estimate * 100).toFixed(0)}pp [${(d.low * 100).toFixed(0)}, ${(d.high * 100).toFixed(0)}]`);
  }
  console.log(`\nfull context: ${pct(summary.fullContext.evidenceRecall)} at ${summary.fullContext.meanTokens} tokens; no memory: 0% at 0`);
  const m = summary.minTokensToAnswer;
  console.log(`median min tokens to reach the evidence: hippo ${m.hippo.median} (${m.hippo.answered}/${summary.questions}), `
    + `recency ${m.recency.median} (${m.recency.answered}/${summary.questions}), full context ${m.fullContextMedian}`);
  console.log(`\nWrote ${path.relative(REPO, outFile)}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
