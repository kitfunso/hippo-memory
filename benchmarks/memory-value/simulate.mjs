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
 *
 * Cross-ingest determinism (codex review fix round, 2026-08-09 P1 fix):
 * memory ids are crypto.randomUUID() (real production path — see ingest.mjs)
 * and therefore DIFFERENT on every ingest of the same dataset+seed. The
 * previous version sorted entries by `.id` and indexed that order with the
 * seeded PRNG, so the SAME rand() draw picked a DIFFERENT logical turn on
 * every re-ingest — reproducible only WITHIN one ingest, not across
 * re-ingests of identical data. Fix: the PRNG samples a position in
 * meta.json's `turns` list ({sessionIndex, turnIdx, memoryId}, written by
 * ingest.mjs in dataset-fixed order — see its header), a key that is
 * IDENTICAL across re-ingests; THIS ingest's current memoryId for that
 * logical turn is resolved via that same list, and the entry's content is
 * read fresh from the store. Effect: same seed + same dataset -> same
 * sequence of logical (sessionIndex, turnIdx) queries, every re-ingest.
 * The seed itself also now reaches this RNG (previously hardcoded 'simulate'
 * with no seed mixed in — a --seed override had zero effect on simulation).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOutcome } from '../../dist/memory.js';
import { writeEntry, loadAllEntries, readEntry } from '../../dist/store.js';
import { hybridSearch, markRetrieved, buildCorpus } from '../../dist/search.js';
import { CONFIG } from './config.mjs';
import { rngFor, pickUniform, setFakeNow, clearFakeNow, hippoRootFor, metaPathFor, questionDir, readJson, writeJsonl, loadDataset } from './common.mjs';

/** Entries sorted by (sessionIndex, turnIdx) via the provenance map — a
 *  stable, dataset-derived positional order (NOT `.id`, which is random per
 *  ingest) so a preparedCorpus built once stays valid across every round
 *  (content/tags never change post-ingest, only the fields
 *  markRetrieved/applyOutcome touch do), and so this order is reproducible
 *  across re-ingests of the same dataset+seed. */
function loadSortedByProvenance(hippoRoot, provenanceByMemoryId) {
  return loadAllEntries(hippoRoot).sort((a, b) => {
    const pa = provenanceByMemoryId.get(a.id);
    const pb = provenanceByMemoryId.get(b.id);
    if (!pa || !pb) {
      throw new Error(`loadSortedByProvenance: entry ${!pa ? a.id : b.id} missing from provenance map (drift)`);
    }
    return pa.sessionIndex - pb.sessionIndex || pa.turnIdx - pb.turnIdx;
  });
}

/**
 * Run the usage simulation against an already-ingested store.
 * @param {string} questionId
 * @param {string} questionDateIso  canonical ISO date (parseLmeDate output)
 * @param {{ rounds?: number, topK?: number, seed?: number, recordRounds?: boolean }} [opts]
 * @returns {{ rounds: number, roundLog: Array<object> }}
 */
export async function simulateQuestion(questionId, questionDateIso, opts = {}) {
  const rounds = opts.rounds ?? CONFIG.SIM_ROUNDS;
  const topK = opts.topK ?? CONFIG.SIM_TOP_K;
  const seed = opts.seed ?? CONFIG.GLOBAL_SEED;
  const hippoRoot = hippoRootFor(questionId);
  const meta = readJson(metaPathFor(questionId));
  const turnsProvenance = meta.turns; // [{sessionIndex, turnIdx, memoryId}], dataset-fixed order (ingest.mjs)
  const provenanceByMemoryId = new Map(turnsProvenance.map((t) => [t.memoryId, t]));
  // Seed mixed in (previously hardcoded 'simulate', questionId — a --seed
  // override had no effect on this RNG at all).
  const rand = rngFor('simulate', String(seed), questionId);
  const roundLog = [];

  setFakeNow(questionDateIso);
  try {
    if (turnsProvenance.length === 0) {
      return { rounds: 0, roundLog: [] };
    }
    const buildEntries = loadSortedByProvenance(hippoRoot, provenanceByMemoryId);
    const corpus = buildCorpus(buildEntries.map((e) => `${e.content} ${e.tags.join(' ')}`));

    for (let r = 0; r < rounds; r++) {
      // Query sampling: uniform over a STABLE (sessionIndex, turnIdx)
      // position in the dataset-derived turn list — never over entries
      // sorted by crypto-random memory_id (see file header). Resolve THIS
      // ingest's current memory_id for that same logical turn, then read
      // its content fresh from the store. Leakage rule: no access to the
      // eval question/answer text anywhere in this function.
      const picked = pickUniform(rand, turnsProvenance);
      const queryEntry = readEntry(hippoRoot, picked.memoryId);
      if (!queryEntry) {
        throw new Error(
          `simulateQuestion: provenance drift — memory ${picked.memoryId} ` +
            `(session ${picked.sessionIndex}, turn ${picked.turnIdx}) not found in store`,
        );
      }
      const query = queryEntry.content.slice(0, CONFIG.QUERY_MAX_CHARS);

      const entriesNow = loadSortedByProvenance(hippoRoot, provenanceByMemoryId);
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
          querySessionIndex: picked.sessionIndex,
          queryTurnIdx: picked.turnIdx,
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
  const seed = parseInt(flag('seed', String(CONFIG.GLOBAL_SEED)), 10);
  if (!dataPath || !questionId) {
    console.error('Usage: simulate.mjs --data <path> --question-id <id> [--seed 42] [--record-rounds]');
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
  simulateQuestion(questionId, meta.questionDate, { seed, recordRounds: process.argv.includes('--record-rounds') }).then(
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
