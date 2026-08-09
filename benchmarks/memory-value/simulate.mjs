#!/usr/bin/env node
/**
 * LC2-E1 — usage simulation: seeded recall+outcome rounds per store.
 *
 * Protocol (pre-reg, pinned in config.mjs): SIM_ROUNDS fixed rounds per
 * store, query = a seeded-uniform-sampled turn from the STORE'S OWN
 * sessions (never the eval question text — the leakage rule), top-K via
 * hippo's real hybridSearch, retrieval strengthening via the real
 * markRetrieved + writeEntry (byte-identical to what cmdRecall/getContext
 * persist), outcome via the real applyOutcome + writeEntry applied to the
 * SAME round's just-recalled ids (the "outcomeForLastRecall"-style coupling:
 * outcome always targets the immediately-preceding recall's result set,
 * never an unrelated id list).
 *
 * Anti-oracle: query sampling is deliberately NOT biased toward gold/
 * evidence turns — a gold-biased simulator would manufacture retrieval_count
 * as a circular gold proxy. Grep proof (leakage rule): this file never reads
 * `question.question` or `question.answer`; it only ever touches
 * `entry.content` loaded back from the store.
 *
 * Clock convention: ALL rounds run under HIPPO_FAKE_NOW = question_date
 * (set once for the whole store, not per round).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOutcome } from '../../dist/memory.js';
import { writeEntry, loadAllEntries } from '../../dist/store.js';
import { hybridSearch, markRetrieved, buildCorpus } from '../../dist/search.js';
import { CONFIG } from './config.mjs';
import { rngFor, pickUniform, setFakeNow, clearFakeNow, hippoRootFor, metaPathFor, questionDir, readJson, writeJsonl, loadDataset } from './common.mjs';

/** Entries sorted by id: a stable positional order so a preparedCorpus built
 *  once stays valid across every round (content/tags never change post-ingest,
 *  only the fields markRetrieved/applyOutcome touch do). */
function loadSorted(hippoRoot) {
  return loadAllEntries(hippoRoot).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Run the usage simulation against an already-ingested store.
 * @param {string} questionId
 * @param {string} questionDateIso  canonical ISO date (parseLmeDate output)
 * @param {{ rounds?: number, topK?: number, recordRounds?: boolean }} [opts]
 * @returns {{ rounds: number, roundLog: Array<object> }}
 */
export async function simulateQuestion(questionId, questionDateIso, opts = {}) {
  const rounds = opts.rounds ?? CONFIG.SIM_ROUNDS;
  const topK = opts.topK ?? CONFIG.SIM_TOP_K;
  const hippoRoot = hippoRootFor(questionId);
  const rand = rngFor('simulate', questionId);
  const roundLog = [];

  setFakeNow(questionDateIso);
  try {
    const buildEntries = loadSorted(hippoRoot);
    if (buildEntries.length === 0) {
      return { rounds: 0, roundLog: [] };
    }
    const corpus = buildCorpus(buildEntries.map((e) => `${e.content} ${e.tags.join(' ')}`));

    for (let r = 0; r < rounds; r++) {
      // Query sampling: uniform over THIS STORE's own memory content only.
      // Leakage rule: no access to the eval question/answer text anywhere
      // in this function.
      const entriesNow = loadSorted(hippoRoot);
      const queryEntry = pickUniform(rand, entriesNow);
      const query = queryEntry.content.slice(0, CONFIG.QUERY_MAX_CHARS);

      const results = await hybridSearch(query, entriesNow, {
        budget: CONFIG.SIM_SEARCH_BUDGET,
        minResults: topK,
        preparedCorpus: corpus,
      });
      const topEntries = results.slice(0, topK).map((x) => x.entry);
      const updated = markRetrieved(topEntries); // now = evalNow() (fake, question_date)
      for (const u of updated) writeEntry(hippoRoot, u);

      const good = r % CONFIG.SIM_NEGATIVE_EVERY !== 2;
      for (const u of updated) {
        const withOutcome = applyOutcome(u, good);
        writeEntry(hippoRoot, withOutcome);
      }

      if (opts.recordRounds) {
        roundLog.push({
          round: r,
          queryFromMemoryId: queryEntry.id,
          queryLength: query.length,
          topKIds: updated.map((u) => u.id),
          good,
        });
      }
    }
  } finally {
    clearFakeNow();
  }

  return { rounds, roundLog };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataPath = flag('data');
  const questionId = flag('question-id');
  if (!dataPath || !questionId) {
    console.error('Usage: simulate.mjs --data <path> --question-id <id> [--record-rounds]');
    process.exit(2);
  }
  const questions = loadDataset(dataPath);
  const q = questions.find((qq) => qq.question_id === questionId);
  if (!q) {
    console.error(`No question found for id ${questionId}.`);
    process.exit(1);
  }
  const meta = readJson(metaPathFor(questionId));
  const t0 = Date.now();
  simulateQuestion(questionId, meta.questionDate, { recordRounds: process.argv.includes('--record-rounds') }).then(
    (r) => {
      console.log(`[simulate] ${questionId}: ${r.rounds} rounds in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (r.roundLog.length > 0) {
        writeJsonl(path.join(questionDir(questionId), 'rounds.jsonl'), r.roundLog);
      }
    },
  ).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
