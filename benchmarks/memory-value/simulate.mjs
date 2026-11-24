#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOutcome } from '../../dist/entry/memory.js';
import { loadAllEntriesIn, readEntryIn, writeEntryIn } from '../../dist/store/sqlite/fixtures.js';
import { storeFilesOf } from '../../dist/store/sqlite/runtime/handles.js';
import { hybridSearch } from '../../dist/entry/eval-scripts.js';
import { buildCorpus } from '../../dist/domain/search/bm25.js';
import { markRetrieved } from '../../dist/entry/memory.js';
import { withSharedStoreHandles } from '../../dist/db/index.js';
import { CONFIG } from './config.mjs';
import { rngFor, pickUniform, setFakeNow, clearFakeNow, hippoRootFor, metaPathFor, questionDir, readJson, writeJsonl, loadDataset } from './common.mjs';

function loadSortedByProvenance(files, provenanceByMemoryId) {
  return loadAllEntriesIn(files).sort((a, b) => {
    const pa = provenanceByMemoryId.get(a.id);
    const pb = provenanceByMemoryId.get(b.id);
    if (!pa || !pb) {
      throw new Error(`loadSortedByProvenance: entry ${!pa ? a.id : b.id} missing from provenance map (drift)`);
    }
    return pa.sessionIndex - pb.sessionIndex || pa.turnIdx - pb.turnIdx;
  });
}

function stableReorderByProvenance(results, provenanceByMemoryId) {
  return results.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = provenanceByMemoryId.get(a.entry.id);
    const pb = provenanceByMemoryId.get(b.entry.id);
    if (!pa || !pb) {
      throw new Error(`stableReorderByProvenance: result ${!pa ? a.entry.id : b.entry.id} missing from provenance map (drift)`);
    }
    return pa.sessionIndex - pb.sessionIndex || pa.turnIdx - pb.turnIdx;
  });
}

/**
 * Run the usage simulation against an already-ingested store.
 * @param {string} questionId
 * @param {string} questionDateIso  the clock to simulate at — callers MUST
 *   pass meta.tEval (the causal clock clamp, ingest.mjs), never the raw
 *   meta.questionDate, or memories from haystack sessions postdating the
 *   question can get negative age_days.
 * @param {{ rounds?: number, topK?: number, seed?: number, recordRounds?: boolean }} [opts]
 * @returns {Promise<{ rounds: number, roundLog: Array<object> }>}
 */
export function simulateQuestion(questionId, questionDateIso, opts = {}) {
  return withSharedStoreHandles((session) => simulateOnSharedHandle(questionId, questionDateIso, { ...opts, session }));
}

async function simulateOnSharedHandle(questionId, questionDateIso, opts) {
  const rounds = opts.rounds ?? CONFIG.SIM_ROUNDS;
  const topK = opts.topK ?? CONFIG.SIM_TOP_K;
  const seed = opts.seed ?? CONFIG.GLOBAL_SEED;
  const hippoRoot = hippoRootFor(questionId);
  const files = storeFilesOf(hippoRoot, { session: opts.session });
  const meta = readJson(metaPathFor(questionId));
  const turnsProvenance = meta.turns;
  const provenanceByMemoryId = new Map(turnsProvenance.map((t) => [t.memoryId, t]));
  const rand = rngFor('simulate', String(seed), questionId);
  const roundLog = [];

  setFakeNow(questionDateIso);
  try {
    if (turnsProvenance.length === 0) {
      return { rounds: 0, roundLog: [] };
    }
    const buildEntries = loadSortedByProvenance(files, provenanceByMemoryId);
    const corpus = buildCorpus(buildEntries.map((e) => `${e.content} ${e.tags.join(' ')}`));

    for (let r = 0; r < rounds; r++) {
      const picked = pickUniform(rand, turnsProvenance);
      const queryEntry = readEntryIn(files, picked.memoryId);
      if (!queryEntry) {
        throw new Error(
          `simulateQuestion: provenance drift — memory ${picked.memoryId} ` +
            `(session ${picked.sessionIndex}, turn ${picked.turnIdx}) not found in store`,
        );
      }
      const query = queryEntry.content.slice(0, CONFIG.QUERY_MAX_CHARS);

      const entriesNow = loadSortedByProvenance(files, provenanceByMemoryId);
      const results = await hybridSearch(query, entriesNow, {
        budget: CONFIG.SIM_SEARCH_BUDGET,
        minResults: topK,
        preparedCorpus: corpus,
      });
      const stableResults = stableReorderByProvenance(results, provenanceByMemoryId);
      const topEntries = stableResults.slice(0, topK).map((x) => x.entry);
      const updated = markRetrieved(topEntries);
      for (const u of updated) writeEntryIn(files, u);

      const good = r % CONFIG.SIM_NEGATIVE_EVERY !== 2;
      for (const u of updated) {
        const withOutcome = applyOutcome(u, good);
        writeEntryIn(files, withOutcome);
      }

      if (opts.recordRounds) {
        roundLog.push({
          round: r,
          querySessionIndex: picked.sessionIndex,
          queryTurnIdx: picked.turnIdx,
          queryFromMemoryId: queryEntry.id,
          queryLength: query.length,
          topKIds: updated.map((u) => u.id),
          topKProvenance: updated.map((u) => {
            const p = provenanceByMemoryId.get(u.id);
            return `${p.sessionIndex}:${p.turnIdx}`;
          }),
          good,
        });
      }
    }
  } finally {
    clearFakeNow();
  }

  return { rounds, roundLog };
}

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
  simulateQuestion(questionId, meta.tEval, { seed, recordRounds: process.argv.includes('--record-rounds') }).then(
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
